import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const root = path.resolve(here, "..");
export const publicDir = path.join(root, "public");

export function getDataDir() {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
  return path.join(root, "data");
}

export function getPort() {
  const n = Number(process.env.PORT || 8787);
  return Number.isFinite(n) && n > 0 ? n : 8787;
}
