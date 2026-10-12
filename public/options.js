// Mode and reasoning for the composer toolbar. The visible reasoning chip is reasoningChipText.
// Ultra is the existing tiered router (plan, build, review, unslop), based on pstack's poteto-mode.

export const ULTRA_HELP = "Ultra forces extra high effort and the tiered Ultra router: plan, build, review, and unslop. Based on pstack's poteto-mode.";

const EFFORTS = ["low", "medium", "high", "xhigh"];
const LONG_STATUSES = new Set(["running", "paused", "stalled", "blocked"]);

export function longRunActive(run) {
  return run === true || (!!run && typeof run === "object" && LONG_STATUSES.has(run.status));
}

export function reasoningChoice({ effort, ultra } = {}) {
  if (ultra) return { id: "ultra", label: "Ultra", effort: "xhigh", ultra: true };
  const id = EFFORTS.includes(effort) ? effort : "high";
  return { id, label: id, effort: id, ultra: false };
}

const MODEL_CHIP = {
  "grok-4.7": "Grok 4.7",
  "grok-4.7-build-fast": "Grok 4.7 Fast",
  "grok-4.6": "Grok 4.6",
  "grok-4.5": "Grok 4.5",
};

const EFFORT_CHIP = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high" };

function modelChipName(model) {
  if (MODEL_CHIP[model]) return MODEL_CHIP[model];
  const raw = String(model || "").trim();
  if (!raw) return "Grok 4.7";
  return raw.replace(/^grok-/i, "Grok ").replace(/-/g, " ").replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

// Visible reasoning chip. Ultra stands alone. Otherwise the model and the effort.
export function reasoningChipText(id, model) {
  if (id === "ultra") return "Ultra";
  return modelChipName(model) + " " + (EFFORT_CHIP[id] || "High");
}

export function applyReasoning(id) {
  if (id === "ultra") return { effort: "xhigh", ultra: true };
  if (EFFORTS.includes(id)) return { effort: id, ultra: false };
  return { effort: "high", ultra: false };
}

// Long run wins, then Plan, then an active loop, otherwise Normal.
export function modeChoice({ plan = false, longRun = null, loops = [] } = {}) {
  if (longRunActive(longRun)) return { id: "long", label: "Long run" };
  if (plan) return { id: "plan", label: "Plan" };
  if ((loops || []).some((loop) => loop && loop.status === "active")) return { id: "loops", label: "Loops" };
  return { id: "normal", label: "Normal" };
}
