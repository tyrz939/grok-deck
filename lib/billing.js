import os from "node:os";
import { startAgent } from "./acp.js";

// Whole-account plan quota from ACP `_x.ai/billing` (`config.creditUsagePercent`).
// A session's tokens are a different number. This call uses its own short-lived agent
// so it does not interrupt a running turn.
const TTL_MS = 5 * 60 * 1000;
const FAIL_TTL_MS = 60 * 1000;
const TIMEOUT_MS = 20 * 1000;

export function parseBilling(result) {
  const config = result && typeof result === "object" ? result.config : null;
  if (!config || typeof config !== "object") return null;
  const percent = config.creditUsagePercent;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  const type = String((config.currentPeriod && config.currentPeriod.type) || "");
  let period = null;
  if (/WEEK/i.test(type)) period = "week";
  else if (/MONTH/i.test(type)) period = "month";
  return { percent, period };
}

export function planUsageLabel(parsed) {
  if (!parsed || typeof parsed.percent !== "number" || !Number.isFinite(parsed.percent)) return "";
  const shown = Math.max(0, Math.round(parsed.percent));
  const word = parsed.period === "week" ? "this week" : parsed.period === "month" ? "this month" : "of plan";
  return shown + "% " + word;
}

export function accountBody(result) {
  const parsed = parseBilling(result);
  if (!parsed) return { available: false };
  return { available: true, percent: parsed.percent, period: parsed.period, label: planUsageLabel(parsed) };
}

export function createBillingCache({ load, now = () => Date.now(), ttlMs = TTL_MS, failTtlMs = FAIL_TTL_MS } = {}) {
  let cached = null;
  let generation = 0;
  let flight = null;
  const normalize = (body) => {
    if (!body || body.available !== true || typeof body.percent !== "number" || !Number.isFinite(body.percent) || typeof body.label !== "string" || !body.label) {
      return { available: false };
    }
    const period = body.period === "week" || body.period === "month" ? body.period : null;
    return { available: true, percent: body.percent, period, label: body.label };
  };
  return {
    invalidate() {
      generation += 1;
      cached = null;
    },
    get() {
      const at = now();
      if (cached && at - cached.at < cached.ttl) return Promise.resolve(cached.body);
      if (flight && flight.gen === generation) return flight.promise;
      const gen = generation;
      const promise = Promise.resolve()
        .then(() => load())
        .then((body) => normalize(body), () => ({ available: false }))
        .then((body) => {
          if (gen === generation) cached = { at: now(), ttl: body.available ? ttlMs : failTtlMs, body };
          return body;
        })
        .finally(() => {
          if (flight && flight.gen === gen) flight = null;
        });
      flight = { gen, promise };
      return promise;
    },
  };
}

function stopAgent(agent) {
  agent.kill("SIGTERM");
  const later = setTimeout(() => agent.kill("SIGKILL"), 500);
  later.unref?.();
}

async function readPlanQuota() {
  const agent = startAgent({ cwd: os.tmpdir() });
  const cap = setTimeout(() => agent.kill("SIGKILL"), TIMEOUT_MS + 2000);
  cap.unref?.();
  try {
    await agent.request(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "grok-build-web", version: "3.0" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
      TIMEOUT_MS
    );
    const result = await agent.request("_x.ai/billing", {}, TIMEOUT_MS);
    return accountBody(result);
  } catch (error) {
    console.error("plan quota", String(error?.message || "error").slice(0, 200));
    throw error;
  } finally {
    clearTimeout(cap);
    stopAgent(agent);
  }
}

const live = createBillingCache({ load: readPlanQuota });

export function accountUsage() {
  return live.get();
}

export function invalidateAccount() {
  live.invalidate();
}
