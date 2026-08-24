import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startStubHomebox } from "./helpers/stub-homebox.mjs";
import { startShim } from "./helpers/shim.mjs";

const TYPES_PATH = "/api/v1/entity-types";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A stub whose /entity-types route is deliberately slow, so concurrent tool calls
 * genuinely overlap and the in-flight dedup guarantee is actually under test.
 */
function slowTypesRoute(delayMs) {
  return {
    [`GET ${TYPES_PATH}`]: (_record, json) =>
      setTimeout(
        () =>
          json(200, [
            { id: "type-item", name: "Item", isLocation: false },
            { id: "type-location", name: "Location", isLocation: true },
          ]),
        delayMs
      ),
  };
}

describe("entity-type cache", () => {
  let homebox;
  let shim;

  afterEach(async () => {
    await shim?.stop();
    await homebox?.close();
    shim = undefined;
    homebox = undefined;
  });

  /** entity-types requests seen by the stub so far. */
  const typeCalls = () => homebox.requests.filter((r) => r.path === TYPES_PATH).length;

  async function createItem(name) {
    const res = await shim.callTool("create_item", { name });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.isError, false, res.body.result.content[0].text);
    return res;
  }

  it("fetches entity types once for many sequential calls (default TTL)", async () => {
    homebox = await startStubHomebox();
    shim = await startShim({ homeboxUrl: homebox.url });

    await createItem("one");
    await createItem("two");
    await createItem("three");

    assert.equal(typeCalls(), 1, `expected 1 entity-types request, saw ${typeCalls()}`);
  });

  it("refetches on every call when ENTITY_TYPE_TTL_MS=0", async () => {
    homebox = await startStubHomebox();
    shim = await startShim({ homeboxUrl: homebox.url, env: { ENTITY_TYPE_TTL_MS: "0" } });

    await createItem("one");
    assert.equal(typeCalls(), 1, `expected 1 request after the first call, saw ${typeCalls()}`);
    await createItem("two");
    assert.equal(typeCalls(), 2, `expected 2 requests after the second call, saw ${typeCalls()}`);
    await createItem("three");
    assert.equal(typeCalls(), 3, `expected 3 requests after the third call, saw ${typeCalls()}`);
  });

  it("refetches after a short TTL expires", async () => {
    homebox = await startStubHomebox();
    shim = await startShim({ homeboxUrl: homebox.url, env: { ENTITY_TYPE_TTL_MS: "50" } });

    await createItem("one");
    assert.equal(typeCalls(), 1, `expected 1 request, saw ${typeCalls()}`);
    await sleep(200); // comfortably past the 50ms TTL
    await createItem("two");
    assert.equal(typeCalls(), 2, `expected a refetch after TTL expiry, saw ${typeCalls()}`);
  });

  it("serves from cache within the TTL window", async () => {
    homebox = await startStubHomebox();
    shim = await startShim({ homeboxUrl: homebox.url, env: { ENTITY_TYPE_TTL_MS: "60000" } });

    await createItem("one");
    await createItem("two");
    assert.equal(typeCalls(), 1, `expected the cache to be reused, saw ${typeCalls()}`);
  });

  it("list_entity_types always forces a refresh", async () => {
    homebox = await startStubHomebox();
    shim = await startShim({ homeboxUrl: homebox.url });

    await createItem("one");
    assert.equal(typeCalls(), 1);

    for (const expected of [2, 3]) {
      const res = await shim.callTool("list_entity_types");
      assert.equal(res.status, 200);
      assert.equal(res.body.result.isError, false, res.body.result.content[0].text);
      const types = JSON.parse(res.body.result.content[0].text);
      assert.equal(types.length, 2);
      assert.equal(
        typeCalls(),
        expected,
        `list_entity_types did not bypass the cache; saw ${typeCalls()} requests`
      );
    }
  });

  it("shares one in-flight refresh across concurrent calls on a cold cache", async () => {
    homebox = await startStubHomebox({ routes: slowTypesRoute(120) });
    shim = await startShim({ homeboxUrl: homebox.url });

    const results = await Promise.all([
      shim.callTool("create_item", { name: "a" }),
      shim.callTool("create_item", { name: "b" }),
      shim.callTool("create_item", { name: "c" }),
      shim.callTool("create_item", { name: "d" }),
    ]);
    for (const res of results) {
      assert.equal(res.status, 200);
      assert.equal(res.body.result.isError, false, res.body.result.content[0].text);
    }

    assert.equal(
      typeCalls(),
      1,
      `concurrent cold-cache calls should share one refresh; saw ${typeCalls()} entity-types requests`
    );
  });

  it("shares one in-flight refresh across concurrent calls on a stale cache", async () => {
    homebox = await startStubHomebox({ routes: slowTypesRoute(120) });
    shim = await startShim({ homeboxUrl: homebox.url, env: { ENTITY_TYPE_TTL_MS: "50" } });

    await shim.callTool("create_item", { name: "warm" });
    assert.equal(typeCalls(), 1);
    await sleep(200); // let the cache go stale

    await Promise.all([
      shim.callTool("create_item", { name: "a" }),
      shim.callTool("create_item", { name: "b" }),
      shim.callTool("create_item", { name: "c" }),
    ]);

    assert.equal(
      typeCalls(),
      2,
      `stale-cache stampede should collapse to one refetch; saw ${typeCalls()} requests`
    );
  });
});
