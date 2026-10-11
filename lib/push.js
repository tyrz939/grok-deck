import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "./paths.js";

// Web Push (RFC 8291 aes128gcm payloads, RFC 8292 VAPID) with node:crypto only.
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (text) => Buffer.from(String(text || ""), "base64url");

function file(name) {
  return path.join(getDataDir(), name);
}

async function readJson(name, fallback) {
  try {
    return JSON.parse(await fs.readFile(file(name), "utf8"));
  } catch {
    return fallback;
  }
}

// Writes are serialised and use a unique temp name, so two quick subscribe calls can't corrupt the file.
let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function writeJson(name, value) {
  const target = file(name);
  const tmp = target + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, target);
}

let keysCache = null;

export async function vapidKeys() {
  if (keysCache) return keysCache;
  let keys = await readJson("vapid.json", null);
  if (!keys?.publicKey || !keys?.privateKey) {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    keys = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()), subject: "mailto:grok-mobile@localhost" };
    await writeJson("vapid.json", keys);
  }
  keysCache = keys;
  return keys;
}

function privateKeyObject(keys) {
  const pub = fromB64u(keys.publicKey);
  return crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: "jwk",
  });
}

export async function vapidHeader(endpoint) {
  const keys = await vapidKeys();
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: keys.subject }));
  const unsigned = header + "." + claims;
  const sig = crypto.sign("sha256", Buffer.from(unsigned), { key: privateKeyObject(keys), dsaEncoding: "ieee-p1363" });
  return "vapid t=" + unsigned + "." + b64u(sig) + ", k=" + keys.publicKey;
}

function hkdf(salt, ikm, info, length) {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));
}

export function encryptPayload(subscription, plaintext) {
  const uaPublic = fromB64u(subscription.keys.p256dh);
  const authSecret = fromB64u(subscription.keys.auth);
  const ecdh = crypto.createECDH("prime256v1");
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);
  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head.writeUInt8(asPublic.length, 20);
  return Buffer.concat([head, asPublic, body]);
}

export async function listSubscriptions() {
  return (await readJson("push.json", { subscriptions: [] })).subscriptions || [];
}

export async function addSubscription(sub, label) {
  if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw Object.assign(new Error("Bad subscription"), { status: 400 });
  }
  return locked(async () => {
    const subs = (await listSubscriptions()).filter((item) => item.endpoint !== sub.endpoint);
    subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, label: String(label || "").slice(0, 80), at: new Date().toISOString() });
    await writeJson("push.json", { subscriptions: subs.slice(-10) });
    return subs.length;
  });
}

export async function removeSubscription(endpoint) {
  return locked(async () => {
    const subs = (await listSubscriptions()).filter((item) => item.endpoint !== endpoint);
    await writeJson("push.json", { subscriptions: subs });
  });
}

export async function sendPush(message) {
  const subs = await listSubscriptions();
  const payload = JSON.stringify(message).slice(0, 3000);
  const results = [];
  for (const sub of subs) {
    try {
      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          Authorization: await vapidHeader(sub.endpoint),
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: "3600",
          Urgency: message.urgent ? "high" : "normal",
        },
        body: encryptPayload(sub, payload),
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 404 || res.status === 410) await removeSubscription(sub.endpoint);
      results.push(res.status);
    } catch (error) {
      results.push(String(error?.code || error?.name || "error"));
    }
  }
  return results;
}
