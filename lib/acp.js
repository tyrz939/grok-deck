import { spawn } from "node:child_process";
import readline from "node:readline";

// Minimal JSON-RPC client for `grok agent stdio` (ACP).
export function startAgent({ cwd, args = [], env = process.env, onNotify, onRequest, onExit }) {
  const child = spawn(process.env.GROK_BIN || "grok", ["agent", "--no-leader", ...args, "stdio"], {
    cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  let nextId = 0;
  const pending = new Map();
  let stderr = "";
  let closed = false;
  const write = (obj) => {
    if (closed || !child.stdin.writable) return;
    try {
      child.stdin.write(JSON.stringify(obj) + "\n");
    } catch {
      // Agent already gone.
    }
  };
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && !msg.method && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) {
        const error = new Error(msg.error.message || "Agent error");
        error.rpc = msg.error;
        reject(error);
      } else resolve(msg.result);
      return;
    }
    if (msg.method && msg.id != null) {
      Promise.resolve()
        .then(() => onRequest?.(msg.method, msg.params || {}, msg.id))
        .then((result) => write({ jsonrpc: "2.0", id: msg.id, result: result ?? null }))
        .catch((error) => write({ jsonrpc: "2.0", id: msg.id, error: { code: Number.isInteger(error?.code) ? error.code : -32603, message: String(error?.message || "error") } }));
      return;
    }
    if (msg.method) {
      try {
        onNotify?.(msg.method, msg.params || {});
      } catch (error) {
        console.error("notify handler", error?.message || "error");
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  child.on("error", () => {});
  child.on("exit", (code, sig) => {
    closed = true;
    for (const { reject } of pending.values()) reject(new Error("Grok exited"));
    pending.clear();
    onExit?.(code, sig, stderr);
  });
  return {
    child,
    // timeoutMs: reject (error.timeout = true) if Grok never answers, so a hung setup call can't wedge the session.
    request(method, params, timeoutMs = 0) {
      return new Promise((resolve, reject) => {
        if (closed) return reject(new Error("Grok exited"));
        const id = ++nextId;
        let timer = null;
        const done = (fn) => (value) => {
          clearTimeout(timer);
          fn(value);
        };
        pending.set(id, { resolve: done(resolve), reject: done(reject) });
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            if (!pending.has(id)) return;
            pending.delete(id);
            const error = new Error("Grok did not answer " + method + " within " + Math.round(timeoutMs / 1000) + "s");
            error.timeout = true;
            reject(error);
          }, timeoutMs);
          timer.unref?.();
        }
        write({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params) {
      write({ jsonrpc: "2.0", method, params });
    },
    kill(sig = "SIGTERM") {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // Gone.
        }
      }
    },
    get stderr() {
      return stderr;
    },
    get closed() {
      return closed;
    },
  };
}
