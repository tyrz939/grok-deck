// Pure label/mode for the single composer action button.
// Idle → Send. Running + empty → Stop. Running + text/images → Send now.
// "Send next" (queue) is not a button label; it lives on form submit / desktop Enter.
export function composerAction({ running = false, chat = false, hasContent = false } = {}) {
  if (!chat || !running) return { label: "Send", mode: "send" };
  if (!hasContent) return { label: "Stop", mode: "stop" };
  return { label: "Send now", mode: "now" };
}

export function hasComposerContent(text, imageCount = 0) {
  return !!(String(text || "").trim() || imageCount > 0);
}
