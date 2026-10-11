import os from "node:os";

const SKIP_IFACE = /^(docker|br-|veth|virbr|cni|flannel|podman|tunl|zt|wg-)/;

export function normalizeIp(ip) {
  if (!ip) return "";
  let value = String(ip).trim();
  if (value.startsWith("::ffff:")) value = value.slice(7);
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  return value;
}

function quad(ip) {
  const parts = normalizeIp(ip).split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255) || parts.some((p) => p === "")) return null;
  return nums;
}

// RFC1918 private ranges: 10/8, 172.16/12, 192.168/16.
export function isPrivateLan(ip) {
  const n = quad(ip);
  if (!n) return false;
  const [a, b] = n;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// LAN clients are only accepted on the TLS listener; plain HTTP stays loopback + Tailscale.
export function isAllowedIp(ip, { tls = false } = {}) {
  if (tls && isPrivateLan(ip)) return true;
  const value = normalizeIp(ip);
  if (!value) return false;
  if (value === "::1") return true;
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 127) return true;
  // Tailscale CGNAT only. The server does not listen on plain LAN addresses.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

// Fail closed when this machine's MagicDNS name is not known yet. Any other *.ts.net host stays rejected.
// Host names accepted on the LAN TLS listener: the LAN IPs, hostname and hostname.local, on the TLS port (or no port).
export function lanHostAllowed(host, { names = [], port }) {
  const raw = String(host || "").toLowerCase();
  const m = raw.match(/^(.*?)(?::(\d+))?$/);
  if (!m || !m[1]) return false;
  if (m[2] && Number(m[2]) !== Number(port)) return false;
  return names.map((n) => String(n).toLowerCase()).includes(m[1]);
}

// IPv4 RFC1918 addresses on real interfaces: the only addresses the HTTPS listener binds.
export function lanAddresses() {
  if (process.env.GM_TLS_ADDRS !== undefined) return process.env.GM_TLS_ADDRS.split(",").map((s) => s.trim()).filter(Boolean);
  const ips = new Set();
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (SKIP_IFACE.test(name)) continue;
    for (const info of list || []) {
      const family = info.family === 4 ? "IPv4" : info.family === 6 ? "IPv6" : info.family;
      if (family === "IPv4" && !info.internal && isPrivateLan(info.address)) ips.add(normalizeIp(info.address));
    }
  }
  return [...ips];
}

export function hostAllowedName(host, { known = [], tailnetName = "" } = {}) {
  const name = String(host || "").toLowerCase().replace(/:\d+$/, "");
  if (!name) return false;
  if (known.includes(name)) return true;
  const tail = String(tailnetName || "").toLowerCase().replace(/\.$/, "");
  if (!tail) return false;
  return name === tail;
}

export function bindAddresses() {
  const ips = new Set(["127.0.0.1"]);
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    if (SKIP_IFACE.test(name)) continue;
    for (const info of list || []) {
      const family = info.family === 4 ? "IPv4" : info.family === 6 ? "IPv6" : info.family;
      if (family === "IPv6" && normalizeIp(info.address) === "::1") {
        ips.add("::1");
        continue;
      }
      if (family !== "IPv4") continue;
      const address = normalizeIp(info.address);
      // Loopback and Tailscale (100.64/10) only: no plain-HTTP LAN listener.
      const [a, b] = address.split(".").map(Number);
      if (a === 100 && b >= 64 && b <= 127) ips.add(address);
    }
  }
  return [...ips];
}

export function clientIp(req) {
  return normalizeIp(req.socket?.remoteAddress || "");
}
