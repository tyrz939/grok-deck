// Which files the composer may attach. Every type is allowed. Size is the only limit.
// Decisions live here so tests can run them without a browser.
export const ATTACH_LIMIT = 25 * 1024 * 1024;
export const ATTACH_MAX = 8;

export function fileName(file) {
  const raw = String(file?.name || "");
  const base = raw.split("/").pop().split("\\").pop();
  return base || "file";
}

// One file: accept it, or a message that says why it was refused. Nothing is dropped quietly.
export function attachmentDecision(file, { have = 0, max = ATTACH_MAX } = {}) {
  const name = fileName(file);
  const size = Number(file?.size);
  if (!file || !Number.isFinite(size) || size < 0) return { ok: false, message: name + " could not be read." };
  if (size > ATTACH_LIMIT) return { ok: false, message: name + " is over the 25 MB limit." };
  if (have >= max) return { ok: false, message: "Attach up to " + max + " files." };
  return { ok: true, file: { name, size, type: String(file.type || "") } };
}

export function takeAttachments(files, opts = {}) {
  const accepted = [];
  const errors = [];
  let have = opts.have || 0;
  for (const file of files || []) {
    const decision = attachmentDecision(file, { have, max: opts.max });
    if (!decision.ok) errors.push(decision.message);
    else {
      accepted.push({ ...decision.file, file });
      have += 1;
    }
  }
  return { accepted, errors };
}

// Paste: every clipboard file, whatever its type. Plain text is not a file.
export function clipboardFiles(data) {
  const out = [];
  const items = data?.items ? [...data.items] : [];
  for (const item of items) {
    if (item?.kind !== "file") continue;
    const file = typeof item.getAsFile === "function" ? item.getAsFile() : null;
    if (file) out.push(file);
  }
  if (out.length) return out;
  return data?.files ? [...data.files].filter(Boolean) : [];
}

export function dropFiles(data) {
  const files = data?.files ? [...data.files].filter(Boolean) : [];
  if (files.length) return files;
  const out = [];
  const items = data?.items ? [...data.items] : [];
  for (const item of items) {
    if (item?.kind !== "file") continue;
    const file = typeof item.getAsFile === "function" ? item.getAsFile() : null;
    if (file) out.push(file);
  }
  return out;
}

// True while a file drag is over the window. Text drags are not a drop target.
export function dragHasFiles(data) {
  const types = data?.types ? [...data.types] : [];
  if (types.includes("Files")) return true;
  const items = data?.items ? [...data.items] : [];
  return items.some((item) => item?.kind === "file");
}
