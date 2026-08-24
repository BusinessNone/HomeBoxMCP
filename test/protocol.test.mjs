import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startStubHomebox } from "./helpers/stub-homebox.mjs";
import { startShim, writeConfig } from "./helpers/shim.mjs";

const EXPECTED_TOOL_COUNT = 16;

describe("JSON-RPC protocol surface", () => {
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

  it("GET /healthz reports ok, a version and the tool count", async () => {
    const res = await shim.get("/healthz");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.server, "homeboxmcp");
    assert.match(res.body.version, /^\d+\.\d+\.\d+/, `unexpected version: ${res.body.version}`);
    assert.equal(res.body.tools, EXPECTED_TOOL_COUNT);
  });

  it("tools/list returns exactly 16 well-formed tools", async () => {
    const res = await shim.rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(res.status, 200);
    const tools = res.body.result.tools;
    assert.equal(tools.length, EXPECTED_TOOL_COUNT);

    const names = new Set();
    for (const tool of tools) {
      assert.equal(typeof tool.name, "string", `tool has no name: ${JSON.stringify(tool)}`);
      assert.ok(tool.name.length > 0, "tool name is empty");
      assert.ok(!names.has(tool.name), `duplicate tool name: ${tool.name}`);
      names.add(tool.name);
      assert.equal(typeof tool.description, "string", `${tool.name} has no description`);
      assert.ok(tool.description.trim().length > 0, `${tool.name} has an empty description`);
      assert.ok(tool.inputSchema, `${tool.name} has no inputSchema`);
      assert.equal(tool.inputSchema.type, "object", `${tool.name} inputSchema is not an object`);
    }
    // The public listing must not leak the server-side implementation.
    for (const tool of tools) assert.equal(tool.run, undefined, `${tool.name} leaks run()`);
  });

  it("initialize returns protocolVersion, serverInfo and capabilities", async () => {
    const res = await shim.rpc({
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "0" } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, 7);
    const r = res.body.result;
    assert.equal(typeof r.protocolVersion, "string");
    assert.ok(r.protocolVersion.length > 0);
    assert.equal(typeof r.serverInfo?.name, "string");
    assert.equal(typeof r.serverInfo?.version, "string");
    assert.ok(r.capabilities, "no capabilities in initialize result");
    assert.ok(r.capabilities.tools, "capabilities does not advertise tools");
  });

  it("ping returns an empty result", async () => {
    const res = await shim.rpc({ jsonrpc: "2.0", id: 2, method: "ping" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { jsonrpc: "2.0", id: 2, result: {} });
  });

  it("an unknown method returns -32601", async () => {
    const res = await shim.rpc({ jsonrpc: "2.0", id: 3, method: "resources/list" });
    assert.equal(res.status, 200);
    assert.equal(res.body.error.code, -32601);
    assert.match(res.body.error.message, /resources\/list/);
  });

  it("an unknown tool name returns -32602", async () => {
    const res = await shim.callTool("definitely_not_a_tool");
    assert.equal(res.status, 200);
    assert.equal(res.body.error.code, -32602);
    assert.match(res.body.error.message, /definitely_not_a_tool/);
  });

  it("malformed JSON returns -32700 with HTTP 400", async () => {
    const res = await shim.post("/mcp", "{ this is not json");
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, -32700);
    assert.equal(res.body.id, null);
  });

  it("a notification (no id) gets HTTP 202 and an empty body", async () => {
    const res = await shim.rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(res.status, 202);
    assert.equal(res.text, "");
  });

  it("a batch request returns an array of responses", async () => {
    const res = await shim.rpc([
      { jsonrpc: "2.0", id: "a", method: "ping" },
      { jsonrpc: "2.0", id: "b", method: "tools/list" },
    ]);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body), `expected an array, got ${res.text}`);
    assert.equal(res.body.length, 2);
    assert.deepEqual(
      res.body.map((r) => r.id).sort(),
      ["a", "b"]
    );
  });

  it("a batch of only notifications gets HTTP 202", async () => {
    const res = await shim.rpc([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled" },
    ]);
    assert.equal(res.status, 202);
    assert.equal(res.text, "");
  });

  it("a tool error is reported as isError, not as a transport error", async () => {
    // list_inbox points at a nonexistent dir here, so use an upload that must fail.
    const res = await shim.callTool("upload_attachment", { id: "ent-1", file: "nope.pdf" });
    assert.equal(res.status, 200);
    assert.equal(res.body.error, undefined, `expected a result, got ${res.text}`);
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /^Error: /);
  });
});

describe("password authentication against Homebox", () => {
  let homebox;
  let shim;

  before(async () => {
    homebox = await startStubHomebox();
    shim = await startShim({
      // A config with no apiKey forces the email/password login path.
      configPath: writeConfig({ homeboxUrl: homebox.url }),
      env: {
        HOMEBOX_URL: homebox.url,
        HOMEBOX_EMAIL: "user@example.com",
        HOMEBOX_PASSWORD: "secret",
      },
    });
  });

  after(async () => {
    await shim?.stop();
    await homebox?.close();
  });

  it("logs in once and uses the returned bearer token", async () => {
    const res = await shim.callTool("list_tags");
    assert.equal(res.status, 200);
    assert.equal(res.body.result.isError, false, res.text);

    const logins = homebox.matching("/users/login");
    assert.equal(logins.length, 1, "expected exactly one login round trip");
    assert.equal(logins[0].json.username, "user@example.com");

    const tagCall = homebox.matching("/tags").at(-1);
    assert.equal(tagCall.headers.authorization, "Bearer stub-session-token");
  });
});
