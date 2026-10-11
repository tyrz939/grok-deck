#!/usr/bin/env node
// One skeptical review through the app's own code (packet, reviewer spawn, verdict parsing, taint check).
// stdin: {cwd, asked, finalText, execs, model, effort, home, sandbox}   stdout: one JSON line.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPacket, extractVerdict, normalizeVerdict, runReviewer, workState } from "../../lib/skeptic.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const before = await workState(input.cwd, []);
const agentFile = path.join(input.home, "agents", "skeptic.md");
fs.mkdirSync(path.dirname(agentFile), { recursive: true });
fs.copyFileSync(path.join(here, "..", "..", "agents", "skeptic.md"), agentFile);
const packet = buildPacket({ cwd: input.cwd, asked: input.asked, finalText: input.finalText, files: before.files, execs: input.execs || [], evidenceText: input.evidenceText || "", state: before });
const t0 = Date.now();
const result = await runReviewer({ cwd: input.cwd, model: input.model, effort: input.effort, packet, extra: { agentFile, args: input.sandbox ? ["--sandbox", input.sandbox] : [], env: { GROK_HOME: input.home } } });
const after = await workState(input.cwd, []);
const verdict = extractVerdict(result.json?.text || result.raw);
const clean = verdict ? normalizeVerdict(verdict) : null;
console.log(JSON.stringify({
  secs: Math.round((Date.now() - t0) / 1000),
  ok: !!clean,
  verdict: clean?.verdict || "error",
  summary: clean?.summary || "",
  issues: clean?.issues || [],
  unverified: clean?.unverified || [],
  ran: clean?.ran || [],
  tokens: Number(result.json?.usage?.total_tokens) || 0,
  inOut: (Number(result.json?.usage?.input_tokens) || 0) + (Number(result.json?.usage?.output_tokens) || 0),
  costUsd: Number(result.json?.total_cost_usd) || 0,
  tainted: after.hash !== before.hash,
  stopReason: result.json?.stopReason || "",
  timedOut: !!result.timedOut,
  raw: clean ? undefined : String(result.json?.text || result.raw || result.err).slice(-800),
}));
