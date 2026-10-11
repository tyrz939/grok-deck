import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Read-only folder browser for the new-session picker. Lists directories only, never leaves the home folder.
const MAX_ENTRIES = 400;

async function homeReal() {
  return fs.realpath(os.homedir());
}

function inside(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

async function isDir(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function defaultDir() {
  const projects = path.join(os.homedir(), "Projects");
  return (await isDir(projects)) ? projects : os.homedir();
}

export async function browseDir(requested, showHidden) {
  const root = await homeReal();
  let target;
  try {
    const raw = String(requested || "").trim() || (await defaultDir());
    const expanded = raw === "~" ? root : raw.startsWith("~/") ? path.join(root, raw.slice(2)) : raw;
    if (!path.isAbsolute(expanded)) return { error: "Use a full path" };
    target = await fs.realpath(path.resolve(expanded));
  } catch {
    return { error: "That folder does not exist" };
  }
  if (!inside(root, target)) return { error: "Only folders inside " + root + " can be browsed" };
  if (!(await isDir(target))) return { error: "That is not a folder" };
  let items;
  try {
    items = await fs.readdir(target, { withFileTypes: true });
  } catch {
    return { error: "Cannot read that folder" };
  }
  const entries = [];
  for (const item of items) {
    if (!showHidden && item.name.startsWith(".")) continue;
    const full = path.join(target, item.name);
    let dir = item.isDirectory();
    if (item.isSymbolicLink()) {
      try {
        const real = await fs.realpath(full);
        dir = inside(root, real) && (await isDir(real));
      } catch {
        dir = false;
      }
    }
    if (!dir) continue;
    entries.push({ name: item.name, path: full, git: await isDir(path.join(full, ".git")) || (await fs.stat(path.join(full, ".git")).then(() => true, () => false)) });
    if (entries.length >= MAX_ENTRIES) break;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return {
    path: target,
    parent: target === root ? null : path.dirname(target),
    home: root,
    git: await fs.stat(path.join(target, ".git")).then(() => true, () => false),
    entries,
    truncated: entries.length >= MAX_ENTRIES,
  };
}

const MAX_NAME = 100;

function checkName(name, showHidden) {
  if (typeof name !== "string" || !name.trim()) return "Enter a folder name";
  if (name !== name.trim()) return "Remove spaces at the start or end of the name";
  if (name.length > MAX_NAME) return "Keep the name under " + MAX_NAME + " characters";
  if (name.includes("..")) return "The name cannot contain ..";
  if (/[\/\\\0]/.test(name)) return "Use a single folder name without slashes";
  if (name.startsWith(".") && !showHidden) return "Turn on Show hidden to create a folder starting with a dot";
  return "";
}

// Creates a folder inside the home folder. Never overwrites or deletes: an existing folder is simply returned.
// Single-name mode: { parent, name }. Path mode: { path } (mkdir -p).
export async function makeDir({ parent, name, path: full, hidden }) {
  const root = await homeReal();
  const showHidden = !!hidden;
  let target;
  if (full != null) {
    if (typeof full !== "string" || !full.trim()) return { error: "Enter a folder path" };
    const raw = full.trim();
    const expanded = raw === "~" ? root : raw.startsWith("~/") ? path.join(root, raw.slice(2)) : raw;
    if (!path.isAbsolute(expanded)) return { error: "Use a full path starting with / or ~/" };
    const parts = expanded.split("/").filter(Boolean);
    for (const part of parts) {
      const problem = checkName(part, showHidden);
      if (problem) return { error: problem + " (" + part + ")" };
    }
    target = path.resolve(expanded);
  } else {
    const problem = checkName(name, showHidden);
    if (problem) return { error: problem };
    let base;
    try {
      base = await fs.realpath(String(parent || ""));
    } catch {
      return { error: "The current folder no longer exists" };
    }
    target = path.join(base, name);
  }
  // Walk up to the deepest existing ancestor and make sure it really lives in the home folder.
  let probe = target;
  while (true) {
    try {
      await fs.lstat(probe);
      break;
    } catch {
      const up = path.dirname(probe);
      if (up === probe) return { error: "Bad path" };
      probe = up;
    }
  }
  let anchor;
  try {
    anchor = await fs.realpath(probe);
  } catch {
    return { error: "Bad path" };
  }
  const finalPath = path.join(anchor, path.relative(probe, target));
  if (!inside(root, finalPath)) return { error: "Folders can only be created inside " + root };
  if (await isDir(finalPath)) return { path: await fs.realpath(finalPath), created: false };
  try {
    await fs.stat(finalPath);
    return { error: "A file with that name already exists" };
  } catch {
    // Free to create.
  }
  try {
    await fs.mkdir(finalPath, { recursive: true, mode: 0o755 });
  } catch (error) {
    return { error: "Could not create the folder (" + (error.code || "error") + ")" };
  }
  return { path: await fs.realpath(finalPath), created: true };
}
