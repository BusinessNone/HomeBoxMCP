// Black-box driver for index.mjs.
//
// index.mjs exports nothing and starts listening at import time, so every test
// spawns it as a child process and talks to it over HTTP. Ports are always
// ephemeral (PORT=0 is not supported by the shim, so we reserve a free port by
// binding one and releasing it) to keep concurrent test files from colliding.
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INDEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "index.mjs");

/** The MCP endpoint the suite exercises by default. */
export const MCP_PATH = "/mcp";

export async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", resolve);
  });
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

export function tempDir(prefix = "homebox-mcp-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write a config.json into a fresh temp dir and return its path. */
export function writeConfig(config) {
  const file = path.join(tempDir(), "config.json");
  fs.writeFileSync(file, JSON.stringify(config), "utf-8");
  return file;
}

/**
 * Spawn index.mjs and resolve once /healthz answers.
 *
 * @param {object} opts
 * @param {string} [opts.homeboxUrl] written into a temp config.json as { homeboxUrl, apiKey }
 * @param {string} [opts.configPath] use an existing config file instead
 * @param {object} [opts.env] extra environment variables
 */
export async function startShim(opts = {}) {
  const port = await freePort();
  const configPath =
    opts.configPath ??
    writeConfig({ homeboxUrl: opts.homeboxUrl ?? "http://127.0.0.1:1", apiKey: "stub-api-key" });

  const child = spawn(process.execPath, [INDEX], {
    env: {
      ...process.env,
      CONFIG_PATH: configPath,
      PORT: String(port),
      // Never let a developer's real inbox leak into a test run.
      INBOX_PATH: opts.env?.INBOX_PATH ?? path.join(tempDir(), "no-inbox"),
      LOG_LEVEL: "debug",
      ...opts.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (c) => (stderr += c));
  child.stdout.on("data", (c) => (stdout += c));

  let exited = null;
  child.on("exit", (code, signal) => (exited = { code, signal }));

  const base = `http://127.0.0.1:${port}`;
  const shim = {
    port,
    base,
    configPath,
    child,
    get stderr() {
      return stderr;
    },
    get stdout() {
      return stdout;
    },
    /** POST a JSON-RPC message (or batch) and return { status, body, text }. */
    async rpc(message, { headers = {}, mcpPath = MCP_PATH } = {}) {
      const body = Buffer.from(JSON.stringify(message), "utf-8");
      return shim.post(mcpPath, body, headers);
    },
    /** POST a raw body to an arbitrary path. */
    async post(urlPath, body, headers = {}) {
      const res = await fetch(`${base}${urlPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
      });
      const text = await res.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      return { status: res.status, text, body: parsed, headers: res.headers };
    },
    async get(urlPath, headers = {}) {
      const res = await fetch(`${base}${urlPath}`, { headers });
      const text = await res.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      return { status: res.status, text, body: parsed };
    },
    /** Call a tool and return the parsed JSON-RPC result. */
    async callTool(name, args = {}, opts2 = {}) {
      const r = await shim.rpc(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        opts2
      );
      return r;
    },
    async stop() {
      if (exited) return exited;
      child.kill("SIGKILL");
      return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    },
  };

  await waitForHealth(base, child, () => (exited ? { exited, stderr } : null));
  return shim;
}

async function waitForHealth(base, child, exitInfo) {
  const deadline = Date.now() + 10000;
  let lastErr;
  while (Date.now() < deadline) {
    const info = exitInfo();
    if (info) {
      throw new Error(
        `index.mjs exited before becoming healthy (code=${info.exited.code}):\n${info.stderr}`
      );
    }
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) {
        await res.text();
        return;
      }
      lastErr = new Error(`/healthz -> ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill("SIGKILL");
  throw new Error(`index.mjs never became healthy: ${lastErr?.message}`);
}

/**
 * Run index.mjs to completion (used for --doctor and startup-validation tests).
 * Resolves with { code, stdout, stderr } - never rejects on a non-zero exit.
 */
export function runShimOnce({ args = [], env = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`index.mjs did not exit within ${timeoutMs}ms. stderr:\n${stderr}`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/**
 * POST a body split into two TCP writes at an exact byte offset.
 *
 * A server that concatenates incoming Buffers onto a JS string (`raw += chunk`)
 * decodes each chunk independently, so a multi-byte character straddling the
 * boundary is destroyed. Splitting deliberately is the only reliable way to
 * reproduce that; the delay between writes guarantees two separate 'data' events.
 */
export function postSplit({ port, urlPath, body, splitAt, headers = {}, delayMs = 60 }) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf-8");
  const head =
    `POST ${urlPath} HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${port}\r\n` +
    `Content-Type: application/json\r\n` +
    Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("") +
    `Content-Length: ${buf.length}\r\n` +
    `Connection: close\r\n\r\n`;

  return new Promise((resolve, reject) => {
    // Write the tail with write(), never end(): half-closing the socket makes Node's
    // HTTP server abandon a response that is still awaiting upstream I/O, which would
    // look like a transport failure rather than the decoding behaviour under test.
    // Connection: close means the server closes the socket once it has replied.
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(head);
      socket.write(buf.subarray(0, splitAt));
      setTimeout(() => socket.write(buf.subarray(splitAt)), delayMs);
    });
    const chunks = [];
    const guard = setTimeout(() => socket.destroy(), 10000);
    socket.on("data", (c) => chunks.push(c));
    socket.on("error", (e) => {
      clearTimeout(guard);
      reject(e);
    });
    socket.on("close", () => {
      clearTimeout(guard);
      const raw = Buffer.concat(chunks).toString("utf-8");
      const sep = raw.indexOf("\r\n\r\n");
      const statusLine = raw.slice(0, raw.indexOf("\r\n"));
      const bodyText = sep === -1 ? "" : raw.slice(sep + 4);
      resolve({
        status: Number(statusLine.split(" ")[1]),
        text: bodyText,
        raw,
      });
    });
  });
}
