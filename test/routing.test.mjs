import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startStubHomebox } from "./helpers/stub-homebox.mjs";
import { freePort, runShimOnce, startShim, writeConfig } from "./helpers/shim.mjs";

const PING = { jsonrpc: "2.0", id: 1, method: "ping" };

describe("MCP endpoint path enforcement", () => {
  let homebox;
  let shim;

  before(async () => {
    homebox = await startStubHomebox();
    shim = await startShim({ homeboxUrl: homebox.url });
  });

  after(async () => {
    await shim?.stop();
    await homebox?.close();
  });

  it("serves JSON-RPC on POST /mcp", async () => {
    const res = await shim.rpc(PING, { mcpPath: "/mcp" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.result, {});
  });

  it("tolerates a trailing slash on POST /mcp/", async () => {
    const res = await shim.rpc(PING, { mcpPath: "/mcp/" });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.result, {});
  });

  it("tolerates a query string on POST /mcp?sessionId=abc", async () => {
    const res = await shim.rpc(PING, { mcpPath: "/mcp?sessionId=abc" });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.result, {});
  });

  it("refuses POST / with a 404 naming the correct endpoint", async () => {
    const res = await shim.rpc(PING, { mcpPath: "/" });
    assert.equal(res.status, 404, `expected 404, got ${res.status}: ${res.text}`);
    assert.equal(res.body.error.code, -32002, res.text);
    assert.match(res.body.error.message, /\/mcp/, `message does not name the endpoint: ${res.text}`);
  });

  it("refuses POST on an unrelated path with the same 404", async () => {
    const res = await shim.rpc(PING, { mcpPath: "/wrong" });
    assert.equal(res.status, 404, `expected 404, got ${res.status}: ${res.text}`);
    assert.equal(res.body.error.code, -32002, res.text);
    assert.match(res.body.error.message, /\/mcp/, res.text);
  });

  it("still serves GET /healthz with 200", async () => {
    const res = await shim.get("/healthz");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it("still serves GET / with 200", async () => {
    const res = await shim.get("/");
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.ok, true);
  });

  it("returns 405 for a non-POST method on the MCP path", async () => {
    const res = await fetch(`${shim.base}/mcp`, { method: "DELETE" });
    await res.text();
    assert.equal(res.status, 405, `expected 405, got ${res.status}`);
  });

  it("returns 405 for GET on the MCP path", async () => {
    const res = await shim.get("/mcp");
    assert.equal(res.status, 405, `expected 405, got ${res.status}: ${res.text}`);
  });
});

describe("MCP_PATH override", () => {
  let homebox;
  let shim;

  before(async () => {
    homebox = await startStubHomebox();
    shim = await startShim({ homeboxUrl: homebox.url, env: { MCP_PATH: "/custom" } });
  });

  after(async () => {
    await shim?.stop();
    await homebox?.close();
  });

  it("serves JSON-RPC on the configured path", async () => {
    const res = await shim.rpc(PING, { mcpPath: "/custom" });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.result, {});
  });

  it("refuses the default /mcp once MCP_PATH is overridden", async () => {
    const res = await shim.rpc(PING, { mcpPath: "/mcp" });
    assert.equal(res.status, 404, `expected 404, got ${res.status}: ${res.text}`);
    assert.equal(res.body.error.code, -32002, res.text);
    assert.match(res.body.error.message, /\/custom/, res.text);
  });

  it("reports the configured path in the startup banner", async () => {
    assert.match(shim.stderr, /\/custom/, `banner did not mention /custom:\n${shim.stderr}`);
  });
});

describe("MCP_PATH validation", () => {
  let homebox;

  before(async () => {
    homebox = await startStubHomebox();
  });

  after(async () => {
    await homebox?.close();
  });

  it("accepts a valid MCP_PATH", async () => {
    const run = await runShimOnce({
      args: ["--doctor"],
      env: {
        CONFIG_PATH: writeConfig({}),
        HOMEBOX_URL: homebox.url,
        HOMEBOX_API_KEY: "stub-api-key",
        PORT: String(await freePort()),
        MCP_PATH: "/custom",
      },
    });
    assert.equal(run.code, 0, `stderr:\n${run.stderr}`);
  });
});
