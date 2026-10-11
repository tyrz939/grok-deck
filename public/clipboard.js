/** Copy plain text to the clipboard. Prefers navigator.clipboard; falls back to a hidden textarea. */
export async function copyText(text, deps = globalThis) {
  const value = String(text ?? "");
  const nav = deps.navigator;
  if (nav?.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(value);
      return true;
    } catch {
      // fall through to the textarea path
    }
  }
  const doc = deps.document;
  if (!doc?.body?.appendChild) return false;
  const ta = doc.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;left:-9999px;top:0";
  doc.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = typeof doc.execCommand === "function" ? !!doc.execCommand("copy") : false;
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}
