// A stand-in for a real Homebox install.
//
// Deliberately reads request bodies as Buffers and only decodes once, at the very
// end, so that any mangling of multi-byte UTF-8 seen in a test is the shim's doing
// and not the stub's.
import http from "node:http";

export async function startStubHomebox(opts = {}) {
  const requests = [];
  const overrides = opts.routes ?? {};

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      const url = new URL(req.url, "http://stub");
      const record = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        rawBody,
        text: rawBody.toString("utf-8"),
      };
      try {
        record.json = rawBody.length ? JSON.parse(record.text) : undefined;
      } catch {
        record.json = undefined;
      }
      requests.push(record);

      const json = (code, obj) => {
        const b = Buffer.from(JSON.stringify(obj), "utf-8");
        res.writeHead(code, { "Content-Type": "application/json", "Content-Length": b.length });
        res.end(b);
      };

      const key = `${req.method} ${url.pathname}`;
      if (overrides[key]) return overrides[key](record, json, res);

      // /api/v1/status - liveness, used by preflightCheck / --doctor.
      if (req.method === "GET" && url.pathname === "/api/v1/status") {
        return json(200, { health: true, versions: ["v0.26.2"] });
      }
      // /api/v1/users/login - password auth path.
      if (req.method === "POST" && url.pathname === "/api/v1/users/login") {
        return json(200, { token: "stub-session-token", expiresAt: "2099-01-01T00:00:00Z" });
      }
      // Entity types are per-install UUIDs in real Homebox; fake stable ones here.
      if (req.method === "GET" && url.pathname === "/api/v1/entity-types") {
        return json(200, [
          { id: "type-item", name: "Item", isLocation: false },
          { id: "type-location", name: "Location", isLocation: true },
        ]);
      }
      if (url.pathname === "/api/v1/tags") {
        if (req.method === "POST") return json(201, { id: "tag-1", ...(record.json ?? {}) });
        return json(200, [{ id: "tag-1", name: "Tools" }]);
      }
      if (url.pathname === "/api/v1/groups/statistics") {
        return json(200, { totalItems: 1, totalLocations: 1, totalLabels: 1, totalItemPrice: 0 });
      }
      if (url.pathname === "/api/v1/entities/tree") {
        return json(200, [{ id: "ent-root", name: "Garage", type: "location", children: [] }]);
      }
      // Attachment upload (multipart/form-data).
      if (req.method === "POST" && /^\/api\/v1\/entities\/[^/]+\/attachments$/.test(url.pathname)) {
        return json(201, { id: "ent-1", attachments: [{ id: "att-1" }] });
      }
      if (req.method === "POST" && url.pathname === "/api/v1/entities") {
        return json(201, { id: "ent-1", ...(record.json ?? {}) });
      }
      if (url.pathname.startsWith("/api/v1/entities")) {
        const id = url.pathname.split("/")[4];
        if (req.method === "GET" && id) {
          return json(200, {
            id,
            name: "Existing entity",
            description: "",
            quantity: 1,
            entityType: { id: "type-item", isLocation: false },
            parent: null,
            tags: [],
          });
        }
        if (req.method === "GET") return json(200, { items: [], total: 0, page: 1, pageSize: 25 });
        return json(200, { id: id ?? "ent-1", ...(record.json ?? {}) });
      }
      return json(404, { error: `stub has no route for ${key}` });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    /** All recorded requests whose path contains `fragment`. */
    matching: (fragment) => requests.filter((r) => r.path.includes(fragment)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
