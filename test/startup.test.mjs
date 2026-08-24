import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startStubHomebox } from "./helpers/stub-homebox.mjs";
import { freePort, runShimOnce, writeConfig } from "./helpers/shim.mjs";

/** Env that satisfies loadConfig() so only the field under test can fail. */
async function baseEnv(homeboxUrl) {
  return {
    CONFIG_PATH: writeConfig({}),
    HOMEBOX_URL: homeboxUrl,
    HOMEBOX_API_KEY: "stub-api-key",
    PORT: String(await freePort()),
  };
}

describe("--doctor", () => {
  let homebox;

  before(async () => {
    homebox = await startStubHomebox();
  });

  after(async () => {
    await homebox?.close();
  });

  it("exits 0 against a reachable Homebox", async () => {
    const run = await runShimOnce({
      args: ["--doctor"],
      env: await baseEnv(homebox.url),
    });
    assert.equal(run.code, 0, `stderr:\n${run.stderr}`);
    assert.match(run.stderr, /"ok":true/);
  });

  it("exits non-zero against an unreachable Homebox", async () => {
    // Port 1 on loopback refuses connections.
    const run = await runShimOnce({
      args: ["--doctor"],
      env: await baseEnv("http://127.0.0.1:1"),
    });
    assert.notEqual(run.code, 0, `expected a non-zero exit; stderr:\n${run.stderr}`);
    assert.match(run.stderr, /"ok":false/);
  });

  it("exits non-zero when the credentials are rejected", async () => {
    // A 401 on /status alone is not a credential failure (Homebox leaves that endpoint
    // open on some installs); the authenticated probe is what must fail the doctor.
    const unauthorized = await startStubHomebox({
      routes: {
        "GET /api/v1/entity-types": (_r, json) => json(401, { error: "unauthorized" }),
      },
    });
    try {
      const run = await runShimOnce({
        args: ["--doctor"],
        env: await baseEnv(unauthorized.url),
      });
      assert.notEqual(run.code, 0, `stderr:\n${run.stderr}`);
      assert.match(run.stderr, /"ok":false/);
      assert.match(run.stderr, /credential|401|unauthorized/i, run.stderr);
    } finally {
      await unauthorized.close();
    }
  });

  it("exits non-zero when Homebox answers /status with a server error", async () => {
    const broken = await startStubHomebox({
      routes: { "GET /api/v1/status": (_r, json) => json(503, { error: "unavailable" }) },
    });
    try {
      const run = await runShimOnce({ args: ["--doctor"], env: await baseEnv(broken.url) });
      assert.notEqual(run.code, 0, `stderr:\n${run.stderr}`);
      assert.match(run.stderr, /"ok":false/);
    } finally {
      await broken.close();
    }
  });
});

describe("startup config validation", () => {
  let homebox;

  before(async () => {
    homebox = await startStubHomebox();
  });

  after(async () => {
    await homebox?.close();
  });

  const cases = [
    {
      name: "an unsupported HOMEBOX_URL scheme",
      env: { HOMEBOX_URL: "ftp://homebox.example.com" },
      expect: /HOMEBOX_URL|scheme/i,
    },
    {
      name: "a non-URL HOMEBOX_URL",
      env: { HOMEBOX_URL: "not-a-url" },
      expect: /HOMEBOX_URL/i,
    },
    {
      name: "an out-of-range PORT",
      env: { PORT: "99999" },
      expect: /PORT/i,
    },
    {
      name: "a non-numeric PORT",
      env: { PORT: "not-a-number" },
      expect: /PORT/i,
    },
    {
      name: "a whitespace-only MCP_AUTH_TOKEN",
      env: { MCP_AUTH_TOKEN: "   " },
      expect: /MCP_AUTH_TOKEN/i,
    },
    {
      name: "a non-positive MAX_REQUEST_BYTES",
      env: { MAX_REQUEST_BYTES: "0" },
      expect: /MAX_REQUEST_BYTES/i,
    },
    {
      name: "MCP_PATH without a leading slash",
      env: { MCP_PATH: "nopath" },
      expect: /MCP_PATH/i,
    },
    {
      name: "MCP_PATH set to the root path",
      env: { MCP_PATH: "/" },
      expect: /MCP_PATH/i,
    },
    {
      name: "a negative ENTITY_TYPE_TTL_MS",
      env: { ENTITY_TYPE_TTL_MS: "-1" },
      expect: /ENTITY_TYPE_TTL_MS/i,
    },
    {
      name: "a non-numeric ENTITY_TYPE_TTL_MS",
      env: { ENTITY_TYPE_TTL_MS: "soon" },
      expect: /ENTITY_TYPE_TTL_MS/i,
    },
  ];

  for (const c of cases) {
    it(`refuses to start with ${c.name}`, async () => {
      const run = await runShimOnce({ env: { ...(await baseEnv(homebox.url)), ...c.env } });
      assert.notEqual(run.code, 0, `expected a non-zero exit; stderr:\n${run.stderr}`);
      assert.match(run.stderr, c.expect, `stderr did not explain the failure:\n${run.stderr}`);
    });
  }

  it("refuses to start with no config at all", async () => {
    const run = await runShimOnce({
      env: {
        CONFIG_PATH: writeConfig({}),
        HOMEBOX_URL: "",
        HOMEBOX_API_KEY: "",
        HOMEBOX_EMAIL: "",
        HOMEBOX_PASSWORD: "",
        PORT: String(await freePort()),
      },
    });
    assert.notEqual(run.code, 0, `stderr:\n${run.stderr}`);
    assert.match(run.stderr, /No config/i);
  });

  it("accepts ENTITY_TYPE_TTL_MS=0 as 'never cache'", async () => {
    // 0 is a meaningful value, not a validation failure: --doctor must still exit 0.
    const run = await runShimOnce({
      args: ["--doctor"],
      env: { ...(await baseEnv(homebox.url)), ENTITY_TYPE_TTL_MS: "0" },
    });
    assert.equal(run.code, 0, `ENTITY_TYPE_TTL_MS=0 was rejected; stderr:\n${run.stderr}`);
  });
});
