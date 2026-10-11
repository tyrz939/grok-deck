import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const FALLBACK = {
  mode: "dark",
  accent: "#F3B77B",
  selection: "#334D5D",
  muted: "#88979F",
  background: "#151E26",
  dark_background: "#10171E",
  darker_background: "#0B1117",
  lighter_background: "#253440",
  foreground: "#ECE5D8",
  dark_foreground: "#A2ACAE",
  light_foreground: "#F3EDE3",
  bright_foreground: "#FFF7EB",
  red: "#EF8D80",
  yellow: "#EAD093",
  orange: "#F3B77B",
  green: "#A9C59A",
  cyan: "#8BC8D0",
  blue: "#7BBCE0",
  magenta: "#C3ABCC",
};

const CSS_MAP = {
  background: "--bg",
  dark_background: "--bg-dark",
  darker_background: "--bg-darker",
  lighter_background: "--bg-light",
  foreground: "--fg",
  dark_foreground: "--fg-dim",
  light_foreground: "--fg-soft",
  bright_foreground: "--fg-bright",
  accent: "--accent",
  muted: "--muted",
  selection: "--selection",
  red: "--red",
  green: "--green",
  yellow: "--yellow",
  blue: "--blue",
  cyan: "--cyan",
  magenta: "--magenta",
  orange: "--orange",
};

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// Only a bare hex color can go into the login page stylesheet.
export function cssColor(value, fallback = "") {
  const text = String(value ?? "").trim();
  return HEX.test(text) ? text : fallback;
}

export function parseColors(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

export function prettifySlug(slug) {
  return String(slug || "")
    .trim()
    .replace(/(^|-)([a-z])/g, (_, boundary, letter) => {
      return (boundary ? " " : "") + letter.toUpperCase();
    });
}

export function slugifyName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function hexByte(hex, shift) {
  return (parseInt(hex.slice(1), 16) >> shift) & 255;
}

export function contrastText(hex) {
  const value = /^#[0-9a-fA-F]{6}$/.test(hex || "") ? hex : "#888888";
  const r = hexByte(value, 16);
  const g = hexByte(value, 8);
  const b = hexByte(value, 0);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.62 ? "#16130f" : "#fffaf4";
}

function execText(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) => {
      if (err) resolve("");
      else resolve(String(stdout || "").trim());
    });
  });
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function resolveThemeDir(slug) {
  if (!slug || slug.includes("/") || slug.includes("..")) return "";
  const userDir = path.join(os.homedir(), ".config", "omarchy", "themes", slug);
  if (await exists(path.join(userDir, "colors.toml"))) return userDir;
  const omarchy = process.env.OMARCHY_PATH || "/usr/share/omarchy";
  const sysDir = path.join(omarchy, "themes", slug);
  if (await exists(path.join(sysDir, "colors.toml"))) return sysDir;
  const fromCli = await execText("omarchy", ["theme", "dir", slug]);
  if (fromCli && (await exists(path.join(fromCli, "colors.toml")))) return fromCli;
  return "";
}

async function activeSlug() {
  const stateFile = path.join(os.homedir(), ".local", "state", "omarchy", "current", "theme.name");
  try {
    const slug = (await fs.readFile(stateFile, "utf8")).trim();
    if (slug) return slug;
  } catch {
    // Fall through to the CLI.
  }
  const pretty = await execText("omarchy", ["theme", "current"]);
  return slugifyName(pretty);
}

function buildTheme(slug, colors, fallback) {
  const merged = { ...FALLBACK, ...colors };
  const vars = {};
  for (const [key, cssName] of Object.entries(CSS_MAP)) {
    const value = cssColor(merged[key], FALLBACK[key]);
    if (value) vars[cssName] = value;
  }
  vars["--on-accent"] = contrastText(vars["--accent"]);
  vars["--banner-bg"] = vars["--orange"] || vars["--accent"];
  vars["--banner-fg"] = contrastText(vars["--banner-bg"]);
  const name = fallback ? "Fallback" : prettifySlug(slug);
  return {
    name,
    slug: fallback ? "fallback" : slug,
    mode: merged.mode === "light" ? "light" : "dark",
    fallback: !!fallback,
    vars,
  };
}

let cache = { stamp: "", theme: null };

async function stampOf(slug) {
  const stateFile = path.join(os.homedir(), ".local", "state", "omarchy", "current", "theme.name");
  const dir = await resolveThemeDir(slug);
  const colorsFile = dir ? path.join(dir, "colors.toml") : "";
  const times = [];
  for (const file of [stateFile, colorsFile]) {
    if (!file) continue;
    try {
      const stat = await fs.stat(file);
      times.push(file + ":" + stat.mtimeMs);
    } catch {
      times.push(file + ":missing");
    }
  }
  return times.join("|");
}

// Grok Deck's own default: Omarchy's bundled Tokyo Night, an indigo and
// violet dark palette with blue accents. The desktop theme is never changed.
const PURPLE_SLUG = "tokyo-night";
const PURPLE_FALLBACK = {
  mode: "dark",
  accent: "#7aa2f7",
  selection: "#292e42",
  muted: "#414868",
  background: "#1a1b26",
  dark_background: "#13141c",
  darker_background: "#0e0e14",
  lighter_background: "#24283b",
  foreground: "#a9b1d6",
  dark_foreground: "#565f89",
  light_foreground: "#b4bee6",
  bright_foreground: "#c0caf5",
  red: "#f7768e",
  yellow: "#e0af68",
  orange: "#eb927b",
  green: "#9ece6a",
  cyan: "#7dcfff",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
};

let purpleCache = null;

async function purpleTheme() {
  if (purpleCache) return purpleCache;
  let colors = PURPLE_FALLBACK;
  try {
    const dir = await resolveThemeDir(PURPLE_SLUG);
    if (dir) {
      const parsed = parseColors(await fs.readFile(path.join(dir, "colors.toml"), "utf8"));
      if (parsed.background && parsed.foreground) colors = { ...PURPLE_FALLBACK, ...parsed };
    }
  } catch {
    // Use the built-in copy.
  }
  const theme = buildTheme(PURPLE_SLUG, colors, false);
  // Brighter cyan reads better for tool names than Tokyo Night's teal; dim text needs more contrast on a phone.
  theme.vars["--cyan"] = "#7dcfff";
  theme.vars["--fg-dim"] = "#8189b4";
  theme.vars["--magenta"] = colors.magenta || "#bb9af7";
  theme.name = "Tokyo Night";
  theme.pref = "purple";
  purpleCache = theme;
  return theme;
}

// The app's palettes. Colours come from the Omarchy theme files when installed; the
// overrides keep every palette visibly distinct (accent hue) and dark.
export const THEME_DEFS = [
  { id: "purple", name: "Tokyo Night", slug: "tokyo-night" },
  { id: "catppuccin", name: "Catppuccin", slug: "catppuccin", override: { accent: "#cba6f7" } },
  { id: "gruvbox", name: "Gruvbox", slug: "gruvbox", override: { accent: "#d8a657" } },
  { id: "nord", name: "Nord", slug: "nord", override: { accent: "#88c0d0" } },
  { id: "everforest", name: "Everforest", slug: "everforest", override: { accent: "#a7c080" } },
  {
    id: "rose-pine",
    name: "Rose Pine",
    slug: "",
    // Omarchy ships the light Dawn variant; this is Rose Pine's dark main palette.
    override: {
      mode: "dark", accent: "#ebbcba", selection: "#403d52", muted: "#6e6a86",
      background: "#191724", dark_background: "#14121d", darker_background: "#100e17", lighter_background: "#26233a",
      foreground: "#e0def4", dark_foreground: "#908caa", light_foreground: "#e0def4", bright_foreground: "#ffffff",
      red: "#eb6f92", yellow: "#f6c177", orange: "#f6c177", green: "#9ccfd8", cyan: "#9ccfd8", blue: "#31748f", magenta: "#c4a7e7",
    },
  },
  { id: "kanagawa", name: "Kanagawa", slug: "kanagawa", override: { accent: "#e46876" } },
  { id: "matte-black", name: "Matte Black", slug: "matte-black", override: { accent: "#e68e0d", yellow: "#e0b050", green: "#8fbf6f" } },
  { id: "osaka-jade", name: "Osaka Jade", slug: "osaka-jade", override: { accent: "#63c597" } },
  { id: "ristretto", name: "Ristretto", slug: "ristretto", override: { accent: "#f38d70" } },
  { id: "liftoff", name: "Liftoff", slug: "theme-liftoff" },
  { id: "desktop", name: "Follow desktop", slug: "" },
];

const themeCache = new Map();

export function themeIds() {
  return THEME_DEFS.map((def) => def.id);
}

export function cleanThemeId(id, fallback = "purple") {
  return THEME_DEFS.some((def) => def.id === id) ? id : fallback;
}

async function namedTheme(def) {
  if (themeCache.has(def.id)) return themeCache.get(def.id);
  let colors = def.id === "liftoff" ? FALLBACK : PURPLE_FALLBACK;
  if (def.slug) {
    try {
      const dir = await resolveThemeDir(def.slug);
      if (dir) {
        const parsed = parseColors(await fs.readFile(path.join(dir, "colors.toml"), "utf8"));
        if (parsed.background && parsed.foreground) colors = { ...colors, ...parsed };
      }
    } catch {
      // Keep the built-in palette.
    }
  }
  colors = { ...colors, ...(def.override || {}) };
  const theme = buildTheme(def.slug || def.id, colors, false);
  theme.vars["--fg-dim"] = mixHex(theme.vars["--fg"], theme.vars["--bg"], 0.42);
  theme.name = def.name;
  theme.pref = def.id;
  theme.id = def.id;
  themeCache.set(def.id, theme);
  return theme;
}

function mixHex(a, b, weight) {
  const ok = (h) => /^#[0-9a-fA-F]{6}$/.test(h || "");
  if (!ok(a) || !ok(b)) return a || b;
  const pa = [16, 8, 0].map((sh) => hexByte(a, sh));
  const pb = [16, 8, 0].map((sh) => hexByte(b, sh));
  return "#" + pa.map((v, i) => Math.round(v * (1 - weight) + pb[i] * weight).toString(16).padStart(2, "0")).join("");
}

export async function getTheme(pref = "purple") {
  if (pref === "desktop") return desktopTheme();
  if (pref === "purple") return purpleTheme();
  const def = THEME_DEFS.find((item) => item.id === pref);
  return def ? namedTheme(def) : purpleTheme();
}

export async function listThemes() {
  const out = [];
  for (const def of THEME_DEFS) {
    const theme = await getTheme(def.id);
    out.push({ id: def.id, name: def.id === "desktop" ? theme.name : def.name, mode: theme.mode, vars: theme.vars });
  }
  return out;
}

async function desktopTheme() {
  const slug = await activeSlug();
  const stamp = (await stampOf(slug)) + "|" + slug;
  if (cache.theme && cache.stamp === stamp) return cache.theme;
  let theme;
  try {
    const dir = await resolveThemeDir(slug);
    if (!dir) throw new Error("no theme dir");
    const text = await fs.readFile(path.join(dir, "colors.toml"), "utf8");
    const colors = parseColors(text);
    if (!colors.background || !colors.foreground) throw new Error("incomplete palette");
    theme = buildTheme(slug || "theme", colors, false);
  } catch {
    theme = buildTheme("fallback", FALLBACK, true);
  }
  theme = { ...theme, pref: "desktop", name: "Follow desktop (" + theme.name + ")" };
  cache = { stamp, theme };
  return theme;
}

export function themeCss(theme) {
  const body = Object.entries(theme?.vars || {})
    .flatMap(([key, value]) => {
      if (!/^--[a-z0-9-]+$/i.test(key)) return [];
      const color = cssColor(value, "");
      return color ? [`${key}:${color}`] : [];
    })
    .join(";");
  return `:root{${body}}`;
}
