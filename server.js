import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import {
  clearCookie,
  createSession,
  destroySession,
  getAuthStatus,
  readCookie,
  sessionCookie,
  sessionFromToken,
  setPassword,
  verifyPassword,
} from "./lib/auth.js";
import { accountUsage } from "./lib/billing.js";
import { browseDir, defaultDir, makeDir } from "./lib/browse.js";
import { addSubscription, removeSubscription, sendPush, vapidKeys } from "./lib/push.js";
import { cancelQueued, enqueue, hasLoopItem, loadQueues, queueFor, sendNow } from "./lib/queue.js";
import { createLoop, deleteLoop, isLoopTurn, loopsFor, parseLoopCommand, startLoops, stopLoopTimers, updateLoop, flushLoops } from "./lib/loops.js";
import { flushRunning, setShuttingDown as stopRecovery, startRecovery } from "./lib/recover.js";
import { cleanThemeId, listThemes } from "./lib/theme.js";
import { cancelAll as cancelSkeptics, cancelReview, dismiss as dismissReview, getSettings as skepticSettings, reviewCount, loadSettings as loadSkepticSettings, reviewFor, usageFor as skepticUsage, sendIssues, setSettings as setSkepticSettings, startReview, startSkeptic, sweepStrayReviewSessions, userSent as skepticUserSent } from "./lib/skeptic.js";
import { LONG_RULES, beginLongRun, flushRuns, isLongRun, loadRuns, longRunFor, setShuttingDown, startSupervisor, stopLongRun } from "./lib/longrun.js";
import { bindAddresses, clientIp, hostAllowedName, isAllowedIp, lanAddresses, lanHostAllowed } from "./lib/net.js";
import { getDataDir, getPort, publicDir } from "./lib/paths.js";
import { activeMap, isBusy, answerPermission, lastEventId, cancelSubagent, cancelTurn, getTurn, startTurn, stopAll, turnEvents, viewTurn, forgetTurn, answerPlan, answerQuestion, watchPayload } from "./lib/runner.js";
import {
  applyManualTitle,
  cleanEffort,
  cleanMode,
  cleanModel,
  cleanTitle,
  isUuid,
  listDirs,
  listSessions,
  loadTranscript,
  getMeta,
  getAppearance,
  getThemePref,
  migrateMeta,
  setAppearance,
  setThemePref,
  sessionRecord,
  setSessionPrefs,
  sessionUsage,
  findSession,
  resolveInside,
  trashSession,
} from "./lib/sessions.js";
import { applyQuestions } from "./lib/history.js";
import { internMessages, internTarget, mediaType, statMedia } from "./lib/media.js";
import { MAX_UPLOAD, saveUpload, sizeLabel } from "./lib/uploads.js";
import { PSTACK_CREDIT, pstackPlugin, skillsFor } from "./lib/skills.js";
import { getTheme, neutralThemeColor, neutralVars, themeCss } from "./lib/theme.js";

const PORT = getPort();
const MODELS = ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"];
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const attempts = new Map();

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

function withSecurity(headers) {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; script-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  };
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(
    code,
    withSecurity({
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
    })
  );
  res.end(body);
}

function sendText(res, code, text) {
  res.writeHead(code, withSecurity({ "Content-Type": "text/plain; charset=utf-8" }));
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 3_000_000) {
        const error = new Error("Request is too large");
        error.status = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!size) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        const error = new Error("Bad JSON");
        error.status = 400;
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function rateBucket(ip) {
  const now = Date.now();
  let bucket = attempts.get(ip);
  if (!bucket || now > bucket.reset) {
    bucket = { fails: 0, reset: now + ATTEMPT_WINDOW_MS, blockedUntil: 0 };
    attempts.set(ip, bucket);
  }
  return bucket;
}

function rateCheck(ip) {
  const bucket = rateBucket(ip);
  if (Date.now() < bucket.blockedUntil) {
    return { ok: false, retry: Math.ceil((bucket.blockedUntil - Date.now()) / 1000) };
  }
  return { ok: true };
}

function rateFail(ip) {
  const bucket = rateBucket(ip);
  bucket.fails += 1;
  if (bucket.fails >= 5) {
    bucket.blockedUntil = Date.now() + ATTEMPT_WINDOW_MS;
    bucket.fails = 0;
  }
}

function rateClear(ip) {
  attempts.delete(ip);
}

async function requireUser(req, res) {
  const user = await sessionFromToken(readCookie(req, "gm_session"));
  if (!user) {
    sendJson(res, 401, { error: "Login required" });
    return false;
  }
  return true;
}

function wantsJson(req) {
  const type = String(req.headers["content-type"] || "");
  return type.includes("application/json");
}

async function transcriptFor(id) {
  const turn = getTurn(id);
  const record = await sessionRecord(id, !!(turn && !turn.done));
  if (!record && !turn) return null;
  if (turn && !turn.done) {
    const view = viewTurn(turn);
    return { session: record, ...view, queue: queueFor(id), loops: loopsFor(id), longRun: longRunFor(id), skeptic: await reviewFor(id) };
  }
  const disk = await loadTranscript(id);
  disk.messages = applyQuestions(disk.messages, (await getMeta()).sessions?.[id]?.asked);
  const found = await findSession(id);
  await internMessages(disk.messages, id, { cwd: found?.cwd, dir: found?.dir });
  if (turn && turn.done) {
    const view = viewTurn(turn);
    const diskLongEnough = disk.messages.length >= Math.max(0, view.messages.length - 1);
    let messages = diskLongEnough ? disk.messages : view.messages;
    const tail = view.messages[view.messages.length - 1];
    if (diskLongEnough && tail && tail.role === "status" && !messages.some((message) => message.role === "status" && message.text === tail.text)) {
      messages = [...messages, tail];
    }
    return { session: record, messages, cursor: lastEventId(turn), running: false, queue: queueFor(id), loops: loopsFor(id), longRun: longRunFor(id), skeptic: await reviewFor(id) };
  }
  return { session: record, messages: disk.messages, cursor: 0, running: false, queue: queueFor(id), loops: loopsFor(id), longRun: longRunFor(id), skeptic: await reviewFor(id) };
}

function manifestFor(appearance) {
  const color = neutralThemeColor(appearance);
  return {
    name: "Grok Deck",
    short_name: "Grok Deck",
    description: "Grok Deck: a front end for Grok Build",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: color,
    theme_color: color,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

async function sendIndex(res) {
  const appearance = await getAppearance();
  let html = await fs.readFile(path.join(publicDir, "index.html"), "utf8");
  html = html.replace("<!--THEME-->", `<style id="theme-vars">${themeCss({ vars: neutralVars(appearance) })}</style>`);
  html = html.replaceAll("__THEME_COLOR__", neutralThemeColor(appearance));
  const body = Buffer.from(html);
  res.writeHead(
    200,
    withSecurity({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
    })
  );
  res.end(body);
}

async function sendFile(res, file) {
  const ext = path.extname(file);
  const type = TYPES[ext] || "application/octet-stream";
  const body = await fs.readFile(file);
  res.writeHead(
    200,
    withSecurity({
      "Content-Type": type,
      "Content-Length": body.length,
      "Cache-Control": ext === ".html" || ext === ".js" || ext === ".css" ? "no-cache" : "public, max-age=86400",
    })
  );
  res.end(body);
}

function streamSession(req, res, id, after) {
  const turn = getTurn(id);
  res.writeHead(
    200,
    withSecurity({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })
  );
  res.write("retry: 1500\n\n");
  if (!turn) {
    res.write('data: {"type":"idle"}\n\n');
    res.end();
    return;
  }
  let cursor = after;
  const send = (row) => {
    if (!row || row.id <= cursor) return;
    cursor = row.id;
    res.write(`id: ${row.id}\ndata: ${JSON.stringify(row.ev)}\n\n`);
    if (row.ev?.type === "settled" && turn.done) {
      turn.listeners.delete(listener);
      clearInterval(ping);
      res.end();
    }
  };
  let ping = null;
  const listener = (row) => send(row);
  turn.listeners.add(listener);
  for (const row of turn.events) {
    if (res.writableEnded) return;
    send(row);
  }
  if (res.writableEnded) return;
  if (turn.done && cursor >= lastEventId(turn)) {
    turn.listeners.delete(listener);
    if (cursor === after) res.write('data: {"type":"idle"}\n\n');
    res.end();
    return;
  }
  ping = setInterval(() => {
    // A data frame, not a comment: the browser only sees data, and uses it to spot a dead connection.
    res.write('data: {"type":"ping"}\n\n');
  }, Number(process.env.GM_SSE_PING_MS) || 15000);
  req.on("close", () => {
    clearInterval(ping);
    turn.listeners.delete(listener);
  });
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const ip = clientIp(req);

  if (req.method === "GET" && pathname === "/api/health") {
    let pending = false;
    try { await fs.access(path.join(getDataDir(), "update-pending")); pending = true; } catch { /* none */ }
    sendJson(res, 200, { ok: true, version: 3, busy: activeMap().size + reviewCount(), busyInteractive: [...activeMap().keys()].filter((id) => !isLongRun(id)).length + reviewCount(), updatePending: pending });
    return;
  }

  if (req.method === "GET" && pathname === "/api/theme") {
    const theme = await getTheme(await getThemePref());
    sendJson(res, 200, theme);
    return;
  }

  if (req.method === "GET" && pathname === "/api/auth/status") {
    const status = await getAuthStatus();
    const authenticated = !!(await sessionFromToken(readCookie(req, "gm_session")));
    sendJson(res, 200, { needsSetup: status.needsSetup, authenticated });
    return;
  }

  if (req.method === "POST" && (pathname === "/api/auth/setup" || pathname === "/api/auth/login")) {
    if (!wantsJson(req)) {
      sendJson(res, 415, { error: "Use JSON" });
      return;
    }
    const limited = rateCheck(ip);
    if (!limited.ok) {
      sendJson(res, 429, { error: "Too many attempts. Try again in " + limited.retry + " seconds." });
      return;
    }
    const body = await readBody(req);
    const password = typeof body.password === "string" ? body.password : "";
    if (pathname === "/api/auth/setup") {
      if (password.length < 10 || password.length > 200) {
        sendJson(res, 400, { error: "Password must be 10 to 200 characters." });
        return;
      }
      try {
        await setPassword(password);
      } catch (error) {
        sendJson(res, error.status || 400, { error: error.message || "Could not set password" });
        return;
      }
    } else {
      const status = await getAuthStatus();
      if (status.needsSetup) {
        sendJson(res, 400, { error: "Set a password first." });
        return;
      }
      const ok = password ? await verifyPassword(password) : false;
      if (!ok) {
        rateFail(ip);
        await new Promise((resolve) => setTimeout(resolve, 400));
        sendJson(res, 401, { error: "Wrong password." });
        return;
      }
    }
    rateClear(ip);
    const session = await createSession();
    res.setHeader("Set-Cookie", sessionCookie(session.token, session.maxAge, isHttps(req)));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/logout") {
    await destroySession(readCookie(req, "gm_session"));
    res.setHeader("Set-Cookie", clearCookie(isHttps(req)));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!(await requireUser(req, res))) return;

  if (req.method === "POST" && pathname === "/api/theme") {
    if (!wantsJson(req)) {
      sendJson(res, 415, { error: "Use JSON" });
      return;
    }
    const body = await readBody(req);
    const pref = body.pref ? await setThemePref(body.pref) : await getThemePref();
    if (body.appearance === "light" || body.appearance === "dark") await setAppearance(body.appearance);
    const theme = await getTheme(pref);
    sendJson(res, 200, { ...theme, appearance: await getAppearance() });
    return;
  }

  if (req.method === "GET" && pathname === "/api/models") {
    sendJson(res, 200, { models: MODELS, default: "grok-4.7" });
    return;
  }

  if (req.method === "GET" && pathname === "/api/themes") {
    sendJson(res, 200, { themes: await listThemes(), global: await getThemePref(), appearance: await getAppearance(), httpsUrl: await httpsUrl() });
    return;
  }

  if (req.method === "GET" && pathname === "/api/push/key") {
    sendJson(res, 200, { publicKey: (await vapidKeys()).publicKey });
    return;
  }

  if (req.method === "POST" && (pathname === "/api/push/subscribe" || pathname === "/api/push/unsubscribe" || pathname === "/api/push/test")) {
    if (!wantsJson(req)) {
      sendJson(res, 415, { error: "Use JSON" });
      return;
    }
    const body = await readBody(req);
    if (pathname === "/api/push/subscribe") await addSubscription(body.subscription, body.label);
    else if (pathname === "/api/push/unsubscribe") await removeSubscription(String(body.endpoint || ""));
    else {
      const results = await sendPush({ title: "Grok Deck", body: "Notifications are working.", url: "/" });
      sendJson(res, 200, { ok: true, results });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/dirs") {
    const dirs = await listDirs();
    sendJson(res, 200, { dirs, home: os.homedir(), defaultDir: await defaultDir() });
    return;
  }

  if (pathname === "/api/mkdir") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Use POST" });
      return;
    }
    const origin = req.headers.origin;
    let crossSite = false;
    try {
      crossSite = !!origin && new URL(origin).host !== req.headers.host;
    } catch {
      crossSite = true;
    }
    if (!wantsJson(req) || crossSite) {
      sendJson(res, 403, { error: "Blocked" });
      return;
    }
    const body = await readBody(req);
    const result = await makeDir({ parent: body.parent, name: body.name, path: body.path, hidden: body.hidden === true });
    if (result.created) console.log("mkdir", result.path);
    sendJson(res, result.error ? 400 : 200, result);
    return;
  }

  if (req.method === "GET" && pathname === "/api/browse") {
    const result = await browseDir(url.searchParams.get("path") || "", url.searchParams.get("hidden") === "1");
    sendJson(res, result.error ? 400 : 200, result);
    return;
  }

  if (req.method === "GET" && pathname === "/api/sessions") {
    const sessions = await listSessions(activeMap());
    sendJson(res, 200, { sessions });
    return;
  }

  // The skills Grok advertised (names and one-line descriptions) for the composer's / picker.
  if (req.method === "GET" && pathname === "/api/skills") {
    const id = url.searchParams.get("session") || "";
    sendJson(res, 200, { skills: await skillsFor(isUuid(id) ? id : ""), credit: PSTACK_CREDIT });
    return;
  }

  if (req.method === "GET" && pathname === "/api/account") {
    sendJson(res, 200, await accountUsage());
    return;
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})$/i);
  const watchMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/watch$/i);
  if (watchMatch && req.method === "GET") {
    watchSession(res, watchMatch[1]);
    return;
  }

  if (sessionMatch && req.method === "DELETE") {
    if (!wantsJson(req)) {
      sendJson(res, 415, { error: "Use JSON" });
      return;
    }
    const id = sessionMatch[1];
    const live = getTurn(id);
    if (live && !live.done) {
      sendJson(res, 409, { error: "Stop the running turn first" });
      return;
    }
    const removed = await trashSession(id);
    forgetTurn(id);
    console.log("session deleted", id, removed ? "(moved to trash)" : "(meta only)");
    sendJson(res, 200, { ok: true });
    return;
  }

  // A reference that was not a file when its message arrived, looked at again (the page asks when it draws the
  // "moved or deleted" card, and when it comes back to the tab). Copies the file into the store if it is there now.
  const recheckMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/media$/i);
  if (recheckMatch && req.method === "POST") {
    if (!wantsJson(req)) {
      sendJson(res, 415, { error: "Use JSON" });
      return;
    }
    const body = await readBody(req);
    const found = await findSession(recheckMatch[1]);
    const target = String(body.target || "").slice(0, 1000);
    if (!found || !target) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const turn = getTurn(recheckMatch[1]);
    const url = await internTarget(target, { cwd: turn?.cwd || found.cwd, dir: found.dir });
    sendJson(res, 200, { url });
    return;
  }

  // The media store: the only place files in messages are served from. A name is a sha256, so it never changes.
  // Range requests are answered because iOS will not play video or audio without them.
  const mediaMatch = pathname.match(/^\/api\/media\/([0-9a-f]{64}\.[a-z0-9]{1,8})$/);
  if (mediaMatch && (req.method === "GET" || req.method === "HEAD")) {
    const found = await statMedia(mediaMatch[1]);
    if (!found) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const type = mediaType(mediaMatch[1]);
    const attach = type === "application/octet-stream" || url.searchParams.get("download") === "1";
    const asked = String(url.searchParams.get("n") || "file").replace(/[^\w. -]+/g, "_").slice(0, 100) || "file";
    const headers = {
      "Content-Type": type,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": (attach ? "attachment" : "inline") + '; filename="' + asked + '"',
    };
    if (type === "application/pdf") Object.assign(headers, { "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": "frame-ancestors 'self'" });
    let start = 0;
    let end = found.size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, found.size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), found.size - 1) : found.size - 1;
      if (start > end || start >= found.size) {
        res.writeHead(416, withSecurity({ "Content-Range": "bytes */" + found.size }));
        res.end();
        return;
      }
      status = 206;
      headers["Content-Range"] = "bytes " + start + "-" + end + "/" + found.size;
    }
    headers["Content-Length"] = end - start + 1;
    res.writeHead(status, withSecurity(headers));
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fsSync.createReadStream(found.file, { start, end }).on("error", () => res.destroy()).pipe(res);
    return;
  }

  const longMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/longrun$/i);
  if (longMatch && req.method === "POST") {
    if (!wantsJson(req)) {
      sendJson(res, 415, { error: "Use JSON" });
      return;
    }
    const id = longMatch[1];
    const body = await readBody(req);
    if (body.action === "stop") {
      sendJson(res, 200, { ok: true, longRun: await stopLongRun(id) });
      return;
    }
    if (body.action === "start" || body.action === "resume") {
      const found = await findSession(id);
      if (!found) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      const prev = longRunFor(id);
      const run = await beginLongRun(id, { goal: body.goal || prev?.goal || "", hours: body.hours || prev?.hours, tokens: body.tokens || prev?.tokens, prefs: {}, resume: body.action === "resume" });
      sendJson(res, 200, { ok: true, longRun: run });
      return;
    }
    sendJson(res, 400, { error: "Unknown action" });
    return;
  }

  if (pathname === "/api/skeptic/settings") {
    if (req.method === "GET") {
      sendJson(res, 200, { settings: skepticSettings() });
      return;
    }
    if (req.method === "PATCH") {
      if (!wantsJson(req)) {
        sendJson(res, 415, { error: "Use JSON" });
        return;
      }
      sendJson(res, 200, { settings: await setSkepticSettings(await readBody(req)) });
      return;
    }
  }

  const skepticMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/skeptic$/i);
  if (skepticMatch && req.method === "POST") {
    if (!wantsJson(req)) {
      sendJson(res, 415, { error: "Use JSON" });
      return;
    }
    const id = skepticMatch[1];
    const body = await readBody(req);
    if (body.action === "run") {
      if (!(await findSession(id))) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      if (isBusy(id)) {
        sendJson(res, 409, { error: "Wait for the running turn to finish" });
        return;
      }
      startReview(id, "manual", {}).catch((error) => console.error("skeptic run failed", error?.message || "error"));
      await new Promise((r) => setTimeout(r, 50));
      sendJson(res, 200, { ok: true, skeptic: await reviewFor(id) });
      return;
    }
    if (body.action === "cancel") {
      cancelReview(id, "Cancelled by the user");
      sendJson(res, 200, { ok: true, skeptic: await reviewFor(id) });
      return;
    }
    if (body.action === "send") {
      sendJson(res, 200, { ok: true, skeptic: await sendIssues(id) });
      return;
    }
    if (body.action === "dismiss") {
      sendJson(res, 200, { ok: true, skeptic: await dismissReview(id) });
      return;
    }
    sendJson(res, 400, { error: "Unknown action" });
    return;
  }

  const usageMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/usage$/i);
  if (usageMatch && req.method === "GET") {
    sendJson(res, 200, { ...(await sessionUsage(usageMatch[1])), skeptic: await skepticUsage(usageMatch[1]) });
    return;
  }

  const loopMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/loops(?:\/([0-9a-f-]{36}))?$/i);
  if (loopMatch) {
    const [, id, lid] = loopMatch;
    if (req.method === "GET" && !lid) {
      sendJson(res, 200, { loops: loopsFor(id) });
      return;
    }
    if (req.method !== "DELETE" && !wantsJson(req)) {
      sendJson(res, 415, { error: "Use JSON" });
      return;
    }
    if (req.method === "POST" && !lid) {
      if (!getTurn(id) && !(await sessionRecord(id, false))) {
        sendJson(res, 404, { error: "Session not found" });
        return;
      }
      const body = await readBody(req);
      let spec = body;
      if (typeof body.command === "string") {
        const cmd = parseLoopCommand(body.command);
        if (!cmd) {
          sendJson(res, 400, { error: "Not a /loop command" });
          return;
        }
        if (cmd.action === "error") {
          sendJson(res, 400, { error: cmd.error });
          return;
        }
        if (cmd.action === "list") {
          sendJson(res, 200, { ok: true, action: "list", loops: loopsFor(id) });
          return;
        }
        if (cmd.action === "stop") {
          const n = deleteLoop(id);
          sendJson(res, 200, { ok: true, action: "stop", removed: n, loops: loopsFor(id) });
          return;
        }
        spec = { ...cmd, opts: body.opts || {} };
      }
      const loop = createLoop(id, { minutes: Number(spec.minutes), prompt: spec.prompt, maxRuns: Number(spec.maxRuns) || 0, untilDone: !!spec.untilDone, opts: spec.opts || {} });
      sendJson(res, 200, { ok: true, action: "create", loop, loops: loopsFor(id), queue: queueFor(id) });
      return;
    }
    if (req.method === "PATCH" && lid) {
      const loop = updateLoop(id, lid, (await readBody(req)).action);
      sendJson(res, loop ? 200 : 404, loop ? { ok: true, loop, loops: loopsFor(id) } : { error: "No such loop or action" });
      return;
    }
    if (req.method === "DELETE" && lid) {
      const n = deleteLoop(id, lid);
      sendJson(res, n ? 200 : 404, n ? { ok: true, loops: loopsFor(id) } : { error: "No such loop" });
      return;
    }
    sendJson(res, 405, { error: "Not allowed" });
    return;
  }

  const queueMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/queue(?:\/([0-9a-f-]{36})(\/now)?)?$/i);
  if (queueMatch) {
    const [, id, qid, now] = queueMatch;
    if (req.method === "POST" && !qid) {
      if (!wantsJson(req)) {
        sendJson(res, 415, { error: "Use JSON" });
        return;
      }
      const qidNew = enqueue(id, await readBody(req));
      sendJson(res, 200, { ok: true, id: qidNew, queue: queueFor(id), longRun: longRunFor(id) });
      return;
    }
    if (req.method === "POST" && qid && now) {
      const ok = sendNow(id, qid);
      sendJson(res, ok ? 200 : 404, ok ? { ok: true, queue: queueFor(id), longRun: longRunFor(id) } : { error: "Already sent" });
      return;
    }
    if (req.method === "DELETE" && qid && !now) {
      const ok = cancelQueued(id, qid);
      sendJson(res, ok ? 200 : 404, ok ? { ok: true, queue: queueFor(id), longRun: longRunFor(id) } : { error: "Already sent" });
      return;
    }
    sendJson(res, 405, { error: "Not allowed" });
    return;
  }

  if (sessionMatch && req.method === "GET") {
    const payload = await transcriptFor(sessionMatch[1]);
    if (!payload) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    sendJson(res, 200, payload);
    return;
  }

  if (sessionMatch && req.method === "PATCH") {
    if (!wantsJson(req)) {
      sendJson(res, 415, { error: "Use JSON" });
      return;
    }
    const id = sessionMatch[1];
    const existing = await sessionRecord(id, !!getTurn(id));
    if (!existing && !getTurn(id)) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    const body = await readBody(req);
    const patch = {};
    if (body.title != null) {
      const title = cleanTitle(body.title);
      if (!title) {
        sendJson(res, 400, { error: "Title is empty" });
        return;
      }
      patch.title = title;
    }
    if (body.model != null) patch.model = cleanModel(body.model);
    if (body.effort != null) patch.effort = cleanEffort(body.effort);
    if (body.permissionMode != null) patch.permissionMode = cleanMode(body.permissionMode);
    if (body.ultra != null) patch.ultra = !!body.ultra;
    if (body.plan != null) {
      patch.plan = !!body.plan;
      if (patch.plan) patch.planUsed = true;
    }
    if (body.skeptic != null) patch.skeptic = ["off", "auto", "always"].includes(body.skeptic) ? body.skeptic : "default";
    if (body.skepticLoop != null) patch.skepticLoop = ["on", "off"].includes(body.skepticLoop) ? body.skepticLoop : "default";
    if (body.theme != null) patch.theme = cleanThemeId(body.theme, "");
    if (body.archived != null) patch.archived = !!body.archived;
    if (Array.isArray(body.autoApprove)) patch.autoApprove = body.autoApprove.filter((kind) => typeof kind === "string" && kind.length < 80).slice(0, 20);
    await setSessionPrefs(id, patch);
    turnEvents.emit("changed", { id, what: "prefs" });
    const live = getTurn(id);
    if (live && !live.done) {
      if (patch.autoApprove) live.autoKinds = new Set(patch.autoApprove);
      if (patch.permissionMode) live.mode = patch.permissionMode; // approvals are decided here, so this applies at once
    }
    if (patch.title) {
      const turn = getTurn(id);
      if (!turn || turn.done) {
        try {
          await applyManualTitle(id, patch.title);
        } catch (error) {
          console.error("rename failed", error?.code || "error");
        }
      }
    }
    const session = await sessionRecord(id, !!(getTurn(id) && !getTurn(id).done));
    sendJson(res, 200, { session });
    return;
  }

  const cancelMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/cancel$/i);
  if (cancelMatch && req.method === "POST") {
    const stopped = cancelTurn(cancelMatch[1]);
    sendJson(res, stopped ? 200 : 409, stopped ? { ok: true } : { error: "Nothing is running" });
    return;
  }

  const subMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/subagents\/([0-9a-f-]{36}|all)\/cancel$/i);
  if (subMatch && req.method === "POST") {
    const result = await cancelSubagent(subMatch[1], subMatch[2]);
    sendJson(res, result.ok ? 200 : result.status || 400, result.ok ? { ok: true, results: result.results } : { error: result.error });
    return;
  }

  const planMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/plan$/i);
  if (planMatch && req.method === "POST") {
    if (!wantsJson(req)) {
      sendJson(res, 415, { error: "Use JSON" });
      return;
    }
    const body = await readBody(req);
    const result = await answerPlan(planMatch[1], String(body.reqId || ""), String(body.decision || ""));
    sendJson(res, result.ok ? 200 : result.status || 400, result.ok ? { ok: true } : { error: result.error });
    return;
  }

  const questionMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/question$/i);
  if (questionMatch && req.method === "POST") {
    if (!wantsJson(req)) {
      sendJson(res, 415, { error: "Use JSON" });
      return;
    }
    const body = await readBody(req);
    const result = await answerQuestion(questionMatch[1], String(body.reqId || ""), { cancel: body.cancel === true, answers: body.answers });
    sendJson(res, result.ok ? 200 : result.status || 400, result.ok ? { ok: true } : { error: result.error });
    return;
  }

  const permMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/permission$/i);
  if (permMatch && req.method === "POST") {
    if (!wantsJson(req)) {
      sendJson(res, 415, { error: "Use JSON" });
      return;
    }
    const body = await readBody(req);
    const result = await answerPermission(permMatch[1], String(body.reqId || ""), String(body.decision || ""));
    sendJson(res, result.ok ? 200 : result.status || 400, result.ok ? { ok: true } : { error: result.error });
    return;
  }

  const streamMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/stream$/i);
  if (streamMatch && req.method === "GET") {
    const headerAfter = Number(req.headers["last-event-id"] || 0);
    const queryAfter = Number(url.searchParams.get("after") || 0);
    const after = Math.max(Number.isFinite(headerAfter) ? headerAfter : 0, Number.isFinite(queryAfter) ? queryAfter : 0);
    streamSession(req, res, streamMatch[1], after);
    return;
  }

  // An attachment: the raw file as the body, its name in ?name=. It goes into the media store; sending the message
  // copies it into the working folder. Over the cap it is read and thrown away, so the answer can be sent.
  if (req.method === "POST" && pathname === "/api/uploads") {
    const name = String(url.searchParams.get("name") || "file");
    const declared = Number(req.headers["content-length"]) || 0;
    if (declared > MAX_UPLOAD) {
      req.resume();
      sendJson(res, 413, { error: name.split(/[\\/]/).pop().slice(-120) + " is " + sizeLabel(declared) + ", over the " + sizeLabel(MAX_UPLOAD) + " limit." });
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_UPLOAD) {
        req.resume();
        sendJson(res, 413, { error: name.split(/[\\/]/).pop().slice(-120) + " is over the " + sizeLabel(MAX_UPLOAD) + " limit." });
        return;
      }
      chunks.push(chunk);
    }
    try {
      sendJson(res, 200, await saveUpload(Buffer.concat(chunks), name));
    } catch (error) {
      sendJson(res, error.status || 500, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/turns") {
    if (!wantsJson(req)) {
      sendJson(res, 415, { error: "Use JSON" });
      return;
    }
    const body = await readBody(req);
    const sessionId = body.sessionId || null;
    if (sessionId && !isUuid(sessionId)) {
      sendJson(res, 400, { error: "Unknown session" });
      return;
    }
    const title = body.title ? cleanTitle(body.title) : "";
    if (sessionId) skepticUserSent(sessionId);
    const result = await startTurn({
      sessionId,
      cwd: body.cwd,
      prompt: body.prompt,
      images: body.images,
      files: body.files,
      model: body.model,
      effort: body.effort,
      permissionMode: body.permissionMode,
      ultra: body.ultra,
      plan: body.plan,
      title,
      extraRules: body.longRun || (sessionId && isLongRun(sessionId)) ? LONG_RULES.join("\n") : undefined,
      longRun: !!(body.longRun || (sessionId && isLongRun(sessionId))),
    });
    if (body.longRun && !sessionId) {
      await beginLongRun(result.sessionId, {
        goal: body.prompt,
        hours: body.longRun.hours,
        tokens: body.longRun.tokens,
        prefs: { model: body.model, effort: body.effort, permissionMode: body.permissionMode, ultra: body.ultra },
      });
    }
    if (body.theme && !sessionId) await setSessionPrefs(result.sessionId, { theme: cleanThemeId(body.theme, "") });
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

// HTTPS only arrives through `tailscale serve`, which proxies to 127.0.0.1 and sets X-Forwarded-Proto.
// The LAN HTTPS listener (port 8788) is TLS end to end.
function isHttps(req) {
  if (req.socket?.encrypted) return true;
  const ip = clientIp(req);
  return (ip === "127.0.0.1" || ip === "::1") && String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";
}

// Host allowlist (stops DNS rebinding) and one same-origin guard for every state-changing request.
const HOST_OK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", os.hostname().toLowerCase()]);
let boundHosts = new Set();
let tailnetName = ""; // this machine's MagicDNS name, e.g. myhost.tailnet-abc.ts.net
function hostAllowed(host) {
  return hostAllowedName(host, { known: [...HOST_OK, ...boundHosts], tailnetName });
}
let lanHosts = [];
function originGuard(req) {
  if (req.socket?.encrypted) {
    if (!lanHostAllowed(req.headers.host, { names: [...lanHosts, os.hostname(), os.hostname() + ".local"], port: TLS_PORT })) return "Unknown host";
  } else if (!hostAllowed(req.headers.host)) return "Unknown host";
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return "";
  const site = String(req.headers["sec-fetch-site"] || "");
  if (site && site !== "same-origin" && site !== "none") return "Cross-site request";
  const origin = req.headers.origin;
  if (origin) {
    let host = "";
    try {
      host = new URL(origin).host;
    } catch {
      return "Bad origin";
    }
    if (host.toLowerCase() !== String(req.headers.host || "").toLowerCase()) return "Cross-origin request";
  }
  return "";
}

async function onRequest(req, res) {
  const ip = clientIp(req);
  if (!isAllowedIp(ip, { tls: Boolean(req.socket?.encrypted) })) {
    sendText(res, 403, "Forbidden");
    return;
  }
  const blocked = originGuard(req);
  if (blocked) {
    sendText(res, 403, blocked);
    return;
  }
  let url;
  try {
    url = new URL(req.url || "/", "http://localhost");
  } catch {
    sendText(res, 400, "Bad request");
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    try {
      await handleApi(req, res, url);
    } catch (error) {
      if (res.headersSent) return;
      const status = error.status || 500;
      if (status >= 500) console.error("request failed", error?.code || error?.message || "error");
      sendJson(res, status, { error: status >= 500 ? "Something went wrong" : error.message });
    }
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "Method not allowed");
    return;
  }
  if (url.pathname === "/manifest.webmanifest") {
    const body = JSON.stringify(manifestFor(await getAppearance()));
    res.writeHead(
      200,
      withSecurity({
        "Content-Type": "application/manifest+json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-cache",
      })
    );
    res.end(body);
    return;
  }
  const raw = decodeURIComponent(url.pathname);
  if (raw.includes("\0")) {
    sendText(res, 400, "Bad request");
    return;
  }
  const rel = raw === "/" ? "index.html" : raw.replace(/^\/+/, "");
  const file = path.resolve(publicDir, rel);
  const root = path.resolve(publicDir);
  if (file !== root && !file.startsWith(root + path.sep)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  let opened = "";
  try {
    opened = await resolveInside(root, file);
  } catch (error) {
    if (error?.code === "EPERM") {
      sendText(res, 403, "Forbidden");
      return;
    }
  }
  try {
    const stat = opened ? await fs.stat(opened) : null;
    if (stat?.isFile()) {
      if (req.method === "HEAD") {
        res.writeHead(200, withSecurity({}));
        res.end();
        return;
      }
      if (opened.endsWith(`${path.sep}index.html`) || opened === path.join(publicDir, "index.html") || file.endsWith(`${path.sep}index.html`)) {
        await sendIndex(res);
        return;
      }
      await sendFile(res, opened);
      return;
    }
  } catch {
    // Fall through to the app shell for routes.
  }
  if (path.extname(raw)) {
    sendText(res, 404, "Not found");
    return;
  }
  await sendIndex(res);
}

const servers = new Map();

function listenOn(address) {
  if (servers.has(address)) return;
  const server = http.createServer((req, res) => {
    onRequest(req, res).catch((error) => {
      console.error("unhandled", error?.code || "error");
      if (!res.headersSent) sendText(res, 500, "Something went wrong");
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.timeout = 0;
  server.on("error", (error) => {
    console.error("listen", address, error.code || "error");
    servers.delete(address);
  });
  server.listen(PORT, address, () => {
    console.log("listening http://" + (address.includes(":") && address !== "::1" ? "[" + address + "]" : address) + ":" + PORT);
  });
  servers.set(address, server);
}

const TLS_PORT = Number(process.env.TLS_PORT || 8788);
const tlsServers = new Map();
let tlsCreds = null;
function loadTls() {
  if (tlsCreds) return tlsCreds;
  const dir = path.join(getDataDir(), "tls");
  try {
    tlsCreds = { key: fsSync.readFileSync(path.join(dir, "key.pem")), cert: fsSync.readFileSync(path.join(dir, "cert.pem")) };
  } catch {
    tlsCreds = null;
  }
  return tlsCreds;
}
function listenTls(address) {
  if (tlsServers.has(address)) return;
  const creds = loadTls();
  if (!creds) return;
  const server = https.createServer({ ...creds, minVersion: "TLSv1.2" }, (req, res) => {
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
    onRequest(req, res).catch((error) => {
      console.error("unhandled", error?.code || "error");
      if (!res.headersSent) sendText(res, 500, "Something went wrong");
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.timeout = 0;
  server.on("error", (error) => {
    console.error("listen tls", address, error.code || "error");
    tlsServers.delete(address);
  });
  server.listen(TLS_PORT, address, () => console.log("listening https://" + address + ":" + TLS_PORT));
  tlsServers.set(address, server);
}

function syncBinds() {
  const lan = new Set(lanAddresses());
  lanHosts = [...lan];
  for (const [address, server] of tlsServers) {
    if (lan.has(address)) continue;
    server.close();
    tlsServers.delete(address);
    console.log("closed tls", address);
  }
  for (const address of lan) listenTls(address);
  const want = new Set(bindAddresses());
  boundHosts = want;
  for (const [address, server] of servers) {
    if (want.has(address)) continue;
    server.close();
    servers.delete(address);
    console.log("closed", address);
  }
  for (const address of want) listenOn(address);
}

async function main() {
  await fs.mkdir(getDataDir(), { recursive: true, mode: 0o700 });
  await migrateMeta();
  await loadRuns();
  await loadQueues();
  const skillDir = await pstackPlugin();
  if (skillDir) console.log("pstack skills", skillDir);
  await startLoops({
    enqueue,
    hasLoopItem,
    notify: async (loop, head, body) => {
      const name = await sessionTitle(loop.sessionId, "");
      sendPush({ title: head + " · " + name, body: String(body || "").slice(0, 160), url: "/s/" + loop.sessionId, tag: "loop-" + loop.id, urgent: !/DONE/.test(head) }).catch(() => {});
    },
  });
  await startRecovery({ isLongRun, hasQueued: (id) => queueFor(id).length > 0 });
  await loadSkepticSettings();
  startSkeptic();
  sweepStrayReviewSessions().catch((error) => console.error("stray review sweep failed", error?.message || "error"));
  startSupervisor(async (run, head, body) => {
    const name = await sessionTitle(run.id, "");
    sendPush({ title: head + " · " + name, body: String(body || "").slice(0, 160), url: "/s/" + run.id, tag: "long-" + run.id, urgent: head !== "Long run done" }).catch(() => {});
  });
  await fs.rm(path.join(getDataDir(), "update-pending"), { force: true });
  const theme = await getTheme(await getThemePref());
  console.log("theme", theme.fallback ? "fallback" : theme.slug, theme.mode);
  console.log("host", os.hostname());
  syncBinds();
  httpsUrl().then((url) => {
    tailnetName = url.replace(/^https:\/\//, "").toLowerCase();
  });
  setInterval(syncBinds, 20_000).unref();
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("shutdown", signal);
  setShuttingDown();
  stopRecovery();
  cancelSkeptics();
  stopLoopTimers();
  await stopAll();
  await flushLoops();
  await flushRuns();
  await flushRunning();
  for (const server of servers.values()) server.close();
  for (const server of tlsServers.values()) server.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((error) => {
  console.error("startup failed", error?.message || "error");
  process.exit(1);
});

async function sessionTitle(id, fallback) {
  try {
    return (await sessionRecord(id, false))?.title || fallback || "Grok";
  } catch {
    return fallback || "Grok";
  }
}

turnEvents.on("permission", async ({ id, title, kind, subName, detail }) => {
  const name = await sessionTitle(id, title);
  sendPush({ title: (kind === "question" ? "Question · " : "Approval needed · ") + name, body: (subName ? subName + ": " : "") + String(detail || "Grok is waiting for you").slice(0, 160), url: "/s/" + id, tag: "perm-" + id, urgent: true }).catch(() => {});
});

turnEvents.on("finished", async ({ id, stopReason, title, error }) => {
  if (stopReason === "cancelled" || stopReason === "denied") return;
  if (isLoopTurn(id)) return; // lib/loops.js pushes only on failure or DONE
  if (isLongRun(id) || longRunFor(id)?.status === "running") return; // the long-run supervisor sends its own
  const name = await sessionTitle(id, title);
  if (stopReason === "error") sendPush({ title: "Error · " + name, body: String(error || "Grok stopped with an error").slice(0, 160), url: "/s/" + id, tag: "end-" + id, urgent: true }).catch(() => {});
  else sendPush({ title: "Done · " + name, body: stopReason === "end_turn" ? "Grok finished." : "Stopped: " + stopReason, url: "/s/" + id, tag: "end-" + id }).catch(() => {});
});

let httpsCache = null;
async function httpsUrl() {
  if (httpsCache !== null) return httpsCache;
  httpsCache = await new Promise((resolve) => {
    execFile("tailscale", ["status", "--json"], { timeout: 4000 }, (err, out) => {
      try {
        const name = JSON.parse(String(out)).Self.DNSName.replace(/\.$/, "");
        resolve(err ? "" : "https://" + name);
      } catch {
        resolve("");
      }
    });
  });
  return httpsCache;
}

// Every open client of a session listens here, so prefs, theme, queue and new turns sync across devices.
const watchers = new Map();

function watchSession(res, id) {
  res.writeHead(200, withSecurity({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" }));
  res.write("retry: 2000\n\n");
  let set = watchers.get(id);
  if (!set) watchers.set(id, (set = new Set()));
  set.add(res);
  const beat = setInterval(() => res.write(": ping\n\n"), 25000);
  res.on("close", () => {
    clearInterval(beat);
    set.delete(res);
    if (!set.size) watchers.delete(id);
  });
}

turnEvents.on("changed", (change) => {
  const set = watchers.get(change.id);
  if (!set) return;
  const line = "data: " + JSON.stringify(watchPayload(change)) + "\n\n";
  for (const res of set) res.write(line);
});
