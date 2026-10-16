import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDataDir } from "./paths.js";

// pstack (poteto's skills, vendored in vendor/cursor-plugins/pstack) marks every skill
// `disable-model-invocation: true`, so Grok would offer them as slash commands but never tell the model
// they exist. buildSkillPlugin mirrors pstack as a Grok plugin with only that one frontmatter line
// dropped; every other file is a symlink to the vendored copy, so relative links between skills still
// resolve. Grok's own loader then does the rest: names and descriptions in the context, the full
// SKILL.md read only when a task calls for it or the user types /name.
const here = path.dirname(fileURLToPath(import.meta.url));
export const PSTACK_DIR = process.env.PSTACK_DIR || path.join(here, "..", "vendor", "cursor-plugins", "pstack");
const LAYOUT = 1; // bump when the mirror's shape changes, so a new folder is built

export const PSTACK_CREDIT = "pstack by Lauren Tan (poteto), MIT: github.com/cursor/plugins/tree/main/pstack";

function stripModelBlock(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return text;
  const head = m[1].split(/\r?\n/).filter((line) => !/^disable-model-invocation\s*:/.test(line)).join("\n");
  return "---\n" + head + "\n---" + text.slice(m[0].length);
}

async function skillDirs(src) {
  const dir = path.join(src, "skills");
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      out.push({ name: entry.name, text: await fs.readFile(path.join(dir, entry.name, "SKILL.md"), "utf8") });
    } catch {
      // a folder without SKILL.md is not a skill
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Content-addressed: a changed pstack gets a new folder, so a Grok process still reading the old one
// never sees files vanish under it.
export async function buildSkillPlugin(src, { root = path.join(getDataDir(), "plugins") } = {}) {
  const skills = await skillDirs(src);
  if (!skills.length) throw new Error("no skills in " + src);
  let manifest = {};
  try {
    manifest = JSON.parse(await fs.readFile(path.join(src, ".cursor-plugin", "plugin.json"), "utf8"));
  } catch {
    // name and description below are enough
  }
  const hash = crypto.createHash("sha256").update(String(LAYOUT)).update(path.resolve(src));
  for (const s of skills) hash.update(s.name).update("\0").update(s.text).update("\0");
  const dest = path.join(root, "pstack-" + hash.digest("hex").slice(0, 12));
  try {
    await fs.access(path.join(dest, ".grok-plugin", "plugin.json"));
    return dest;
  } catch {
    // build it
  }
  const tmp = dest + ".tmp-" + process.pid + "-" + Date.now();
  await fs.mkdir(path.join(tmp, ".grok-plugin"), { recursive: true });
  const plugin = {
    name: "pstack",
    version: manifest.version || "0.0.0",
    description: manifest.description || "pstack skills",
    author: manifest.author || { name: "Lauren Tan" },
    homepage: manifest.homepage,
    license: manifest.license || "MIT",
  };
  await fs.writeFile(path.join(tmp, ".grok-plugin", "plugin.json"), JSON.stringify(plugin, null, 2) + "\n");
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (entry.name === "skills" || entry.name.startsWith(".")) continue;
    await fs.symlink(path.resolve(src, entry.name), path.join(tmp, entry.name));
  }
  for (const s of skills) {
    const from = path.resolve(src, "skills", s.name);
    const to = path.join(tmp, "skills", s.name);
    await fs.mkdir(to, { recursive: true });
    for (const entry of await fs.readdir(from)) {
      if (entry !== "SKILL.md") await fs.symlink(path.join(from, entry), path.join(to, entry));
    }
    await fs.writeFile(path.join(to, "SKILL.md"), stripModelBlock(s.text));
  }
  try {
    await fs.rename(tmp, dest);
  } catch (error) {
    await fs.rm(tmp, { recursive: true, force: true });
    if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
  }
  return dest;
}

// Grok's available_commands_update lists built-in commands, workflows and skills. Only skills (an entry
// with a SKILL.md path) go to the picker: a built-in like /always-approve would bypass the app's approvals.
export function skillsFromCommands(commands) {
  if (!Array.isArray(commands)) return [];
  const out = [];
  for (const c of commands) {
    const meta = c?._meta || {};
    if (typeof c?.name !== "string" || typeof meta.path !== "string" || !/SKILL\.md$/i.test(meta.path)) continue;
    out.push({
      name: c.name,
      description: typeof c.description === "string" ? c.description.replace(/\s+/g, " ").trim() : "",
      source: sourceOf(meta),
      hint: typeof c.input?.hint === "string" ? c.input.hint : "",
    });
  }
  const rank = (s) => (s.source === "pstack" ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function sourceOf(meta) {
  // A plugin skill's path sits in the generated mirror; that folder name is the plugin.
  if (/\/plugins\/pstack-[0-9a-f]+\//.test(meta.path)) return "pstack";
  return meta.scope === "local" ? "plugin" : String(meta.scope || "other");
}

// The plugin every session loads; null when pstack is not checked out (sessions still run without it).
let built = null;
export function pstackPlugin() {
  if (!built) {
    built = buildSkillPlugin(PSTACK_DIR).catch((error) => {
      console.error("pstack skills not loaded:", error?.message || "error");
      built = null;
      return null;
    });
  }
  return built;
}

// What Grok last advertised, per session and overall. The overall list is kept in data/skills.json so a
// new chat has a picker before any Grok process has started this boot.
const live = new Map();
let latest = null;
const cacheFile = () => path.join(getDataDir(), "skills.json");

export function noteCommands(sessionId, commands) {
  const skills = skillsFromCommands(commands);
  if (!skills.length) return;
  if (sessionId) live.set(sessionId, skills);
  latest = skills;
  fs.writeFile(cacheFile(), JSON.stringify({ at: Date.now(), skills })).catch(() => {});
}

export async function skillsFor(sessionId) {
  if (sessionId && live.has(sessionId)) return live.get(sessionId);
  if (latest) return latest;
  try {
    const saved = JSON.parse(await fs.readFile(cacheFile(), "utf8"));
    if (Array.isArray(saved.skills) && saved.skills.length) return (latest = saved.skills);
  } catch {
    // never cached: read the mirror Grok will load
  }
  const dir = await pstackPlugin();
  if (!dir) return [];
  const out = [];
  for (const s of await skillDirs(dir)) {
    out.push({ name: s.name, description: frontmatterField(s.text, "description"), source: "pstack", hint: "" });
  }
  return out;
}

// Enough YAML for a SKILL.md header: a plain or quoted scalar, or a folded/literal block.
export function frontmatterField(text, key) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ""));
  if (!m) return "";
  const lines = m[1].split(/\r?\n/);
  const i = lines.findIndex((line) => line.startsWith(key + ":"));
  if (i < 0) return "";
  let value = lines[i].slice(key.length + 1).trim();
  if (!value || /^[>|][+-]?$/.test(value)) {
    const block = [];
    for (let j = i + 1; j < lines.length && /^\s+\S|^\s*$/.test(lines[j]); j++) block.push(lines[j].trim());
    value = block.join(" ");
  } else if (/^["']/.test(value)) {
    const q = value[0];
    value = value.slice(1, value.lastIndexOf(q) > 0 ? value.lastIndexOf(q) : undefined);
    if (q === '"') value = value.replace(/\\"/g, '"');
    else value = value.replace(/''/g, "'");
  }
  return value.replace(/\s+/g, " ").trim();
}
