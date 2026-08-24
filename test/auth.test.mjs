import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startStubHomebox } from "./helpers/stub-homebox.mjs";
import { startShim } from "./helpers/shim.mjs";

const TOKEN = "s3cret-mcp-token";
const PING = { jsonrpc: "2.0", id: 1, method: "ping" };

describe("MCP_AUTH_TOKEN gating", () => {
  let homebox;
  let shim;

  before(async () => {
    homebox = await startStubHomebox();
    shim = await startShim({ homeboxUrl: homebox.url, env: { MCP_AUTH_TOKEN: TOKEN } });
  });

  after(async () => {
    await shim?.stop();
    await homebox?.close();
  });

  it("rejects a request with no token", async () => {
    const res = await shim.rpc(PING);
    assert.equal(res.status, 401);
    assert.match(res.body.error.message, /auth/i);
  });

  it("rejects a wrong bearer token", async () => {
    const res = await shim.rpc(PING, { headers: { Authorization: "Bearer wrong-token" } });
    assert.equal(res.status, 401);
  });

  it("rejects a wrong X-MCP-Token", async () => {
    const res = await shim.rpc(PING, { headers: { "X-MCP-Token": "wrong-token" } });
    assert.equal(res.status, 401);
  });

  it("accepts the correct Authorization: Bearer token", async () => {
    const res = await shim.rpc(PING, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.result, {});
  });

  it("accepts the alternate X-MCP-Token header", async () => {
    const res = await shim.rpc(PING, { headers: { "X-MCP-Token": TOKEN } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.result, {});
  });

  it("leaves GET /healthz unauthenticated so orchestrators can probe it", async () => {
    const res = await shim.get("/healthz");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });
});

describe("no MCP_AUTH_TOKEN configured", () => {
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

  it("accepts unauthenticated requests", async () => {
    const res = await shim.rpc(PING);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.result, {});
  });
});
