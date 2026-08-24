// Homebox MCP shim - stateless streamable HTTP, zero dependencies.
// Targets the Homebox v0.26.x entity API (items + locations unified as "entities",
// labels renamed to "tags"). Built against /swagger/doc.json on v0.26.2.
import http from "node:http";
import fs from "node:fs";

const CONFIG_PATH = process.env.CONFIG_PATH || "/config/config.json";
const PORT = Number(process.env.PORT || 3334);

function loadConfig() {
  // API key wins: it needs no refresh. Falls back to email/password login.
  const key = process.env.HOMEBOX_API_KEY;
  const url = process.env.HOMEBOX_URL;
  if (key && url) return { homeboxUrl: url, apiKey: key };
  if (fs.existsSync(CONFIG_PATH)) {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    if (c.homeboxUrl) return c;
  }
  if (url && process.env.HOMEBOX_EMAIL && process.env.HOMEBOX_PASSWORD) {
    return {
      homeboxUrl: url,
      email: process.env.HOMEBOX_EMAIL,
      password: process.env.HOMEBOX_PASSWORD,
    };
  }
  console.error(`No config: need ${CONFIG_PATH} or HOMEBOX_URL + credentials`);
  process.exit(1);
}

const cfg = loadConfig();
const BASE = cfg.homeboxUrl.replace(/\/$/, "") + "/api/v1";
let token = cfg.apiKey ? `Bearer ${cfg.apiKey}` : null;
let typeCache = null;

async function login() {
  if (cfg.apiKey) return token;
  const r = await fetch(`${BASE}/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: cfg.email, password: cfg.password }),
  });
  if (!r.ok) throw new Error(`login failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  const t = j.token || j.accessToken;
  if (!t) throw new Error("login returned no token");
  token = t.startsWith("Bearer ") ? t : `Bearer ${t}`;
  return token;
}

// Single request path. Re-authenticates once on 401 so a expired token is invisible.
async function api(method, path, body, _retried = false) {
  if (!token) await login();
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: token,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (r.status === 401 && !cfg.apiKey && !_retried) {
    token = null;
    return api(method, path, body, true);
  }
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Homebox creates these per-install, so never hardcode the UUIDs.
async function entityTypes() {
  if (typeCache) return typeCache;
  const list = await api("GET", "/entity-types");
  typeCache = {
    item: list.find((t) => !t.isLocation)?.id,
    location: list.find((t) => t.isLocation)?.id,
    all: list,
  };
  if (!typeCache.item || !typeCache.location) {
    typeCache = null;
    throw new Error("could not resolve item/location entity types");
  }
  return typeCache;
}

// GET returns EntityOut (entityType/parent/tags as OBJECTS plus read-only extras);
// PUT expects EntityUpdate (entityTypeId/parentId/tagIds as STRINGS). Sending EntityOut
// straight back would drop those three and blank the entity's type, location and tags.
const WRITABLE = new Set([
  "name", "description", "quantity", "notes", "assetId", "archived", "insured",
  "manufacturer", "modelNumber", "serialNumber", "purchasePrice", "purchaseDate",
  "purchaseFrom", "lifetimeWarranty", "warrantyDetails", "warrantyExpires",
  "soldPrice", "soldDate", "soldTo", "soldNotes", "syncChildEntityLocations", "fields",
]);

function toUpdatePayload(current, patch = {}) {
  const out = { id: current.id };
  for (const k of WRITABLE) if (current[k] !== undefined) out[k] = current[k];
  out.entityTypeId = current.entityType?.id ?? current.entityTypeId;
  out.parentId = current.parent?.id ?? current.parentId ?? null;
  out.tagIds = Array.isArray(current.tags)
    ? current.tags.map((t) => (typeof t === "string" ? t : t.id))
    : (current.tagIds ?? []);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || k === "id") continue;
    if (k === "parentId" && !v) { out.parentId = null; continue; }
    out[k] = v;
  }
  if (!out.name) throw new Error("name is required and missing");
  return out;
}

function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else p.append(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

// Rich fields only exist on EntityUpdate, so a detailed create is POST then PUT.
async function createEntity(isLocation, a) {
  const types = await entityTypes();
  const created = await api("POST", "/entities", {
    name: a.name,
    description: a.description ?? "",
    entityTypeId: isLocation ? types.location : types.item,
    parentId: a.parentId || null,
    quantity: a.quantity ?? (isLocation ? 0 : 1),
    tagIds: a.tagIds ?? [],
  });
  const rich = Object.fromEntries(
    Object.entries(a).filter(
      ([k, v]) => v !== undefined && WRITABLE.has(k) &&
        !["name", "description", "quantity"].includes(k)
    )
  );
  if (Object.keys(rich).length === 0) return created;
  const current = await api("GET", `/entities/${created.id}`);
  return api("PUT", `/entities/${created.id}`, toUpdatePayload(current, rich));
}

const S = (desc) => ({ type: "string", description: desc });
const N = (desc) => ({ type: "number", description: desc });
const B = (desc) => ({ type: "boolean", description: desc });
const ARR = (desc) => ({ type: "array", items: { type: "string" }, description: desc });

const RICH = {
  manufacturer: S("Manufacturer / brand"),
  modelNumber: S("Model number"),
  serialNumber: S("Serial number"),
  purchasePrice: N("Purchase price"),
  purchaseDate: S("Purchase date, ISO 8601 (e.g. 2026-08-21T00:00:00Z)"),
  purchaseFrom: S("Where it was bought"),
  warrantyExpires: S("Warranty expiry, ISO 8601"),
  warrantyDetails: S("Warranty notes"),
  lifetimeWarranty: B("True if warranty never expires"),
  insured: B("Covered by insurance"),
  notes: S("Free-form notes"),
  assetId: S("Asset ID / tag"),
};

const TOOLS = [
  {
    name: "search_entities",
    description:
      "Search items and locations. Server-side filtering via q (text), tags (tag IDs) and parentIds (location IDs). Returns a paginated list.",
    inputSchema: {
      type: "object",
      properties: {
        q: S("Free-text search"),
        tags: ARR("Filter to these tag IDs"),
        parentIds: ARR("Filter to children of these entity IDs"),
        page: N("1-based page number"),
        pageSize: N("Results per page"),
      },
    },
    run: (a) => api("GET", `/entities${qs(a)}`),
  },
  {
    name: "entity_tree",
    description:
      "Full location/item hierarchy as a tree. Use this to discover location IDs before creating items.",
    inputSchema: { type: "object", properties: {} },
    run: () => api("GET", "/entities/tree"),
  },
  {
    name: "get_entity",
    description: "Fetch one item or location by ID, including attachments and children.",
    inputSchema: { type: "object", properties: { id: S("Entity ID") }, required: ["id"] },
    run: (a) => api("GET", `/entities/${a.id}`),
  },
  {
    name: "create_location",
    description:
      "Create a location (room, shelf, container). Pass parentId to nest it inside another location.",
    inputSchema: {
      type: "object",
      properties: {
        name: S("Location name"),
        description: S("Description"),
        parentId: S("Parent location ID for nesting"),
        notes: RICH.notes,
      },
      required: ["name"],
    },
    run: (a) => createEntity(true, a),
  },
  {
    name: "create_item",
    description:
      "Create an inventory item. parentId is the location it lives in (get IDs from entity_tree). Optional detail fields are applied in the same call.",
    inputSchema: {
      type: "object",
      properties: {
        name: S("Item name"),
        parentId: S("Location ID this item lives in"),
        description: S("Description"),
        quantity: N("Quantity (default 1)"),
        tagIds: ARR("Tag IDs to apply"),
        ...RICH,
      },
      required: ["name"],
    },
    run: (a) => createEntity(false, a),
  },
  {
    name: "update_entity",
    description:
      "Update fields on an existing item or location. Reads the entity first and merges, so unspecified fields are preserved.",
    inputSchema: {
      type: "object",
      properties: {
        id: S("Entity ID"),
        name: S("New name"),
        description: S("Description"),
        quantity: N("Quantity"),
        tagIds: ARR("Replace tags with these IDs"),
        parentId: S("Move to this location ID"),
        archived: B("Archive/unarchive"),
        ...RICH,
      },
      required: ["id"],
    },
    run: async (a) => {
      const { id, ...patch } = a;
      const current = await api("GET", `/entities/${id}`);
      return api("PUT", `/entities/${id}`, toUpdatePayload(current, patch));
    },
  },
  {
    name: "move_entity",
    description: "Move an item or location into a different parent location.",
    inputSchema: {
      type: "object",
      properties: {
        id: S("Entity ID to move"),
        parentId: S("Destination location ID. Pass an empty string or omit to move to the top level."),
      },
      required: ["id", "parentId"],
    },
    run: async (a) => {
      // PATCH applies a new parent, but silently IGNORES parentId:null (merge-patch
      // semantics: null means "unchanged"). Clearing a parent only works via PUT,
      // so route that case through the full merge payload.
      if (a.parentId) {
        return api("PATCH", `/entities/${a.id}`, { id: a.id, parentId: a.parentId });
      }
      const current = await api("GET", `/entities/${a.id}`);
      return api("PUT", `/entities/${a.id}`, toUpdatePayload(current, { parentId: null }));
    },
  },
  {
    name: "delete_entity",
    description: "Permanently delete an item or location. Deleting a location also affects its children.",
    inputSchema: { type: "object", properties: { id: S("Entity ID") }, required: ["id"] },
    run: async (a) => {
      await api("DELETE", `/entities/${a.id}`);
      return { deleted: a.id };
    },
  },
  {
    name: "list_tags",
    description: "List all tags (formerly labels).",
    inputSchema: { type: "object", properties: {} },
    run: () => api("GET", "/tags"),
  },
  {
    name: "create_tag",
    description: "Create a tag that can then be applied to items.",
    inputSchema: {
      type: "object",
      properties: { name: S("Tag name"), description: S("Description"), color: S("Hex colour") },
      required: ["name"],
    },
    run: (a) =>
      api("POST", "/tags", {
        name: a.name,
        description: a.description ?? "",
        color: a.color ?? "",
      }),
  },
  {
    name: "list_entity_types",
    description: "List entity types for this install, showing which ID means item vs location.",
    inputSchema: { type: "object", properties: {} },
    run: async () => (await entityTypes()).all,
  },
  {
    name: "get_stats",
    description: "Group totals: item count, location count, tag count, total value.",
    inputSchema: { type: "object", properties: {} },
    run: () => api("GET", "/groups/statistics"),
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const PUBLIC = TOOLS.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));

async function handleRpc(msg) {
  const { id, method, params } = msg ?? {};
  const reply = (result) => ({ jsonrpc: "2.0", id, result });

  if (method === "initialize") {
    return reply({
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "homebox-shim", version: "1.0.0" },
      instructions:
        "Homebox inventory. Call entity_tree first to discover location IDs, then create_item with parentId set.",
    });
  }
  if (method === "tools/list") return reply({ tools: PUBLIC });
  if (method === "tools/call") {
    const tool = BY_NAME.get(params?.name);
    if (!tool) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `unknown tool: ${params?.name}` },
      };
    }
    try {
      const out = await tool.run(params.arguments ?? {});
      return reply({
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        isError: false,
      });
    } catch (e) {
      // Surface as a tool error, not a transport error, so the model can react.
      return reply({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
    }
  }
  if (method === "ping") return reply({});
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } };
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    const b = obj === null ? "" : JSON.stringify(obj);
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(b),
    });
    res.end(b);
  };

  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
    return send(200, { ok: true, server: "homebox-shim", tools: PUBLIC.length });
  }
  if (req.method !== "POST") return send(405, { error: "method not allowed" });

  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > 4_000_000) req.destroy();
  });
  req.on("end", async () => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    if (process.env.DEBUG_RPC) console.error("RAW>>> " + raw.slice(0, 500));
    // Notifications carry no id and expect no body.
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map(handleRpc))).filter((r) => r.id !== undefined);
      return out.length ? send(200, out) : send(202, null);
    }
    if (msg.id === undefined) return send(202, null);
    try {
      send(200, await handleRpc(msg));
    } catch (e) {
      send(500, { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: e.message } });
    }
  });
});

server.listen(PORT, "0.0.0.0", () =>
  console.error(`homebox-shim listening on :${PORT}/mcp -> ${BASE} (${PUBLIC.length} tools)`)
);
