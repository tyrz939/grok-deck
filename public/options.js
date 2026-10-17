// Mode and reasoning for the composer toolbar. The visible reasoning chip is reasoningChipText.
// Deep mode is the tiered router (plan, build, review, unslop), based on pstack's poteto-mode.
// It is not a reasoning level. While it is on, the turn still runs at extra high.

export const REVIEW_HELP = "Forces extra high effort and runs plan, build, review, and unslop. Based on pstack's poteto-mode.";

const EFFORTS = ["low", "medium", "high", "xhigh"];
const LONG_STATUSES = new Set(["running", "paused", "stalled", "blocked"]);

export function longRunActive(run) {
  return run === true || (!!run && typeof run === "object" && LONG_STATUSES.has(run.status));
}

export function reasoningChoice({ effort, ultra } = {}) {
  const stored = EFFORTS.includes(effort) ? effort : "high";
  const id = ultra ? "xhigh" : stored;
  return { id, label: id, effort: id, ultra: !!ultra };
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

export function reasoningChipParts(id, model) {
  return { model: modelChipName(model), effort: EFFORT_CHIP[id] || "High" };
}

// Visible reasoning chip. Deep mode does not replace this label.
export function reasoningChipText(id, model) {
  const parts = reasoningChipParts(id, model);
  return parts.model + " " + parts.effort;
}

// Picking an effort below extra high turns Deep mode off. Extra high keeps it.
export function applyReasoning(id, { review = false } = {}) {
  if (!EFFORTS.includes(id)) return { effort: "high", ultra: false };
  return { effort: id, ultra: id === "xhigh" && !!review };
}

// Deep mode forces extra high. Turning it off leaves the effort where it is.
export function applyReview(on) {
  return on ? { effort: "xhigh", ultra: true } : { ultra: false };
}

// Long run wins, then Plan, then an active loop, otherwise Normal.
export function modeChoice({ plan = false, longRun = null, loops = [] } = {}) {
  if (longRunActive(longRun)) return { id: "long", label: "Long run" };
  if (plan) return { id: "plan", label: "Plan" };
  if ((loops || []).some((loop) => loop && loop.status === "active")) return { id: "loops", label: "Loops" };
  return { id: "normal", label: "Normal" };
}
