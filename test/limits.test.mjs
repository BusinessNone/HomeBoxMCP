import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startStubHomebox } from "./helpers/stub-homebox.mjs";
import { MCP_PATH, postSplit, startShim } from "./helpers/shim.mjs";

describe("MAX_REQUEST_BYTES", () => {
  let homebox;
  let shim;

  before(async () => {
    homebox = await startStubHomebox();
    shim = await startShim({ homeboxUrl: homebox.url, env: { MAX_REQUEST_BYTES: "512" } });
  });

  after(async () => {
    await shim?.stop();
    await homebox?.close();
  });

  it("accepts a body under the limit", async () => {
    const res = await shim.rpc({ jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal(res.status, 200);
  });

  it("rejects an oversize body with 413", async () => {
    const oversize = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "create_item", arguments: { name: "x".repeat(2000) } },
    };
    const res = await shim.rpc(oversize);
    assert.equal(res.status, 413, `expected 413, got ${res.status}: ${res.text}`);
    assert.match(res.body.error.message, /exceeds/i);
  });
});

describe("multi-byte UTF-8 round trip", () => {
  const NAME = "Café 日本語 🔧";
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

  it("passes a multi-byte item name through to Homebox unchanged", async () => {
    const res = await shim.callTool("create_item", { name: NAME });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.isError, false, res.text);

    const create = homebox.requests.find((r) => r.method === "POST" && r.path === "/api/v1/entities");
    assert.ok(create, "Homebox never received the create request");
    assert.equal(create.json.name, NAME);
    assert.ok(!create.text.includes("�"), "body reached Homebox with replacement characters");
  });

  it("survives a body split mid-character across two TCP writes", async () => {
    // Reproduces the classic `raw += chunk` decoding bug: each chunk is decoded
    // independently, so a character straddling the boundary becomes U+FFFD.
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: { name: "create_item", arguments: { name: NAME } },
      }),
      "utf-8"
    );

    // Split inside the 4-byte 🔧 (U+1F527), the widest character in the payload.
    const wrench = Buffer.from("🔧", "utf-8");
    const wrenchAt = body.indexOf(wrench);
    assert.notEqual(wrenchAt, -1, "test payload lost its emoji");
    const splitAt = wrenchAt + 2;

    const before = homebox.requests.length;
    const res = await postSplit({ port: shim.port, urlPath: MCP_PATH, body, splitAt });
    assert.equal(res.status, 200, `split request failed: ${res.raw}`);

    const create = homebox.requests
      .slice(before)
      .find((r) => r.method === "POST" && r.path === "/api/v1/entities");
    assert.ok(create, `Homebox never received the create request. shim replied: ${res.text}`);
    assert.ok(
      !create.text.includes("�"),
      `body was corrupted in transit: ${JSON.stringify(create.text)}`
    );
    assert.equal(create.json.name, NAME);
  });

  it("counts the request limit in bytes, not UTF-16 code units", async () => {
    // A 4-byte emoji is 2 UTF-16 units, so a byte-based limit must trip first.
    const shim2 = await startShim({
      homeboxUrl: homebox.url,
      env: { MAX_REQUEST_BYTES: "400" },
    });
    try {
      const res = await shim2.rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_item", arguments: { name: "🔧".repeat(200) } },
      });
      assert.equal(res.status, 413, `expected 413, got ${res.status}: ${res.text}`);
    } finally {
      await shim2.stop();
    }
  });
});
