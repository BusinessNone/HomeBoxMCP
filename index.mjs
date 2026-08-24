// Homebox MCP shim - stateless streamable HTTP, zero dependencies.
// Targets the Homebox v0.26.x entity API (items + locations unified as "entities",
// labels renamed to "tags"). Built against /swagger/doc.json on v0.26.2.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const VERSION = "1.1.1";
const CONFIG_PATH = process.env.CONFIG_PATH || "/config/config.json";
const PORT = Number(process.env.PORT || 3334);
const MAX_REQUEST_BYTES = Number(process.env.MAX_REQUEST_BYTES || 4_000_000);
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const LOG_PRIORITY = { error: 50, warn: 40, info: 30, debug: 20 };

function log(level, event, meta = {}) {
  const normalized = (level || "info").toLowerCase();
  if ((LOG_PRIORITY[normalized] ?? LOG_PRIORITY.info) < (LOG_PRIORITY[LOG_LEVEL] ?? LOG_PRIORITY.info)) {
    return;
  }
  const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: normalized,
      event,
      ...meta,
    });
  process.stderr.write(`${entry}\n`);
}

function parseConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("config must be a JSON object");
    return parsed;
  } catch (e) {
    throw new Error(`invalid JSON in ${CONFIG_PATH}: ${e.message}`);
  }
}

function loadConfig() {
  const fileCfg = parseConfigFile();
  const key = (process.env.HOMEBOX_API_KEY || fileCfg.apiKey || "").trim();
  const url = (process.env.HOMEBOX_URL || fileCfg.homeboxUrl || "").trim();

  if (key && url) {
    return { homeboxUrl: url, apiKey: key };
  }

  if (url && process.env.HOMEBOX_EMAIL && process.env.HOMEBOX_PASSWORD) {
    return {
      homeboxUrl: url,
      email: process.env.HOMEBOX_EMAIL,
      password: process.env.HOMEBOX_PASSWORD,
    };
  }

  if (fileCfg.homeboxUrl && (fileCfg.apiKey || (fileCfg.email && fileCfg.password))) {
    return {
      homeboxUrl: fileCfg.homeboxUrl,
      ...(fileCfg.apiKey ? { apiKey: fileCfg.apiKey } : { email: fileCfg.email, password: fileCfg.password }),
    };
  }

  throw new Error(`No config: set HOMEBOX_URL + credentials or create ${CONFIG_PATH}`);
}

function validateConfig(cfg) {
  try {
    const u = new URL(cfg.homeboxUrl);
    if (!["http:", "https:"].includes(u.protocol)) {
      throw new Error(`unsupported URL scheme: ${u.protocol}`);
    }
  } catch (e) {
    throw new Error(`invalid HOMEBOX_URL: ${cfg.homeboxUrl} (${e.message})`);
  }

  if (!Number.isFinite(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error(`PORT must be between 1 and 65535; received ${PORT}`);
  }

  if (!Number.isFinite(MAX_REQUEST_BYTES) || MAX_REQUEST_BYTES <= 0) {
    throw new Error(`MAX_REQUEST_BYTES must be a positive number; received ${MAX_REQUEST_BYTES}`);
  }

  if (process.env.MCP_AUTH_TOKEN && process.env.MCP_AUTH_TOKEN.trim() === "") {
    throw new Error("MCP_AUTH_TOKEN must not be empty when set");
  }
}

const cfg = loadConfig();
validateConfig(cfg);
const BASE = cfg.homeboxUrl.replace(/\/$/, "") + "/api/v1";
let token = cfg.apiKey ? `Bearer ${cfg.apiKey}` : null;
let typeCache = null;

async function safeFetch(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e?.name === "AbortError") {
      throw new Error(`request timed out after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function login() {
  if (cfg.apiKey) return token;
  const r = await safeFetch(`${BASE}/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: cfg.email, password: cfg.password }),
  });
  if (!r.ok) throw new Error(`login failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  const t = j.token || j.accessToken;
  if (!t) throw new Error("login returned no token");
    token = /^Bearer\s+/i.test(t) ? t : `Bearer ${t}`;
return token;
}

// Single request path. Re-authenticates once on 401 so an expired token is invisible.
async function api(method, path, body, _retried = false) {
  if (!token) await login();
  const r = await safeFetch(`${BASE}${path}`, {
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

async function preflightCheck() {
  try {
    const r = await safeFetch(`${cfg.homeboxUrl.replace(/\/$/, "")}/api/v1/status`, { method: "GET" }, 10000);
    if (r.status === 401) {
      return { ok: false, reason: "unauthorized" };
    }
    if (!r.ok) {
      return { ok: false, reason: `http_${r.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
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


// ── Attachments ──────────────────────────────────────────────────────────────
// Homebox takes attachments as multipart/form-data on POST /entities/{id}/attachments.
// MCP tool calls are JSON, so bytes reach us via a read-only inbox mount rather than
// being inlined as base64 (a 10MB file would be ~13MB of base64 in the model's context).
const INBOX = process.env.INBOX_PATH || "/inbox";

// Homebox's own cap (HBOX_WEB_MAX_UPLOAD_SIZE, in MB). Reject early with a clear
// message instead of letting the server return an opaque 413/422.
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 10);

const ATTACHMENT_TYPES = ["attachment", "photo", "manual", "warranty", "receipt", "thumbnail"];

const MIME = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", heic: "image/heic", svg: "image/svg+xml",
  txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  doc: "application/msword", xls: "application/vnd.ms-excel", zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const mimeFor = (n) => MIME[(n.split(".").pop() || "").toLowerCase()] || "application/octet-stream";

// Resolve a caller-supplied name against the inbox WITHOUT letting it escape.
// path.resolve collapses ../ so we compare the final real path to the inbox root.
function inboxPath(rel) {
  if (!rel || typeof rel !== "string") throw new Error("file is required");
  const full = path.resolve(INBOX, rel);
  const root = fs.existsSync(INBOX) ? fs.realpathSync.native(INBOX) : path.resolve(INBOX);
  try {
    const target = fs.existsSync(full) ? fs.realpathSync.native(full) : path.resolve(full);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`refused: '${rel}' resolves outside the inbox`);
    }
  } catch (e) {
    if (e.message && e.message.includes("resolves outside the inbox")) throw e;
    throw new Error(`refused: '${rel}' resolves outside the inbox`);
  }
  if (!fs.existsSync(full)) {
    throw new Error(`not found: '${rel}'. Use list_inbox to see available files.`);
  }
  if (!fs.statSync(full).isFile()) throw new Error(`not a file: '${rel}'`);
  return full;
}

// Same auth/retry contract as api(), but lets fetch set its own multipart boundary.
// api() hardcodes Content-Type: application/json, so multipart needs this parallel path.
async function apiUpload(urlPath, form, _retried = false) {
  if (!token) await login();
  const r = await safeFetch(`${BASE}${urlPath}`, {
    method: "POST",
    headers: { Authorization: token },
    body: form,
  });
  if (r.status === 401 && !cfg.apiKey && !_retried) {
    token = null;
    return apiUpload(urlPath, form, true);
  }
  const text = await r.text();
  if (!r.ok) throw new Error(`POST ${urlPath} -> ${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
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
  {
    name: "list_inbox",
    description:
      "List files staged in the upload inbox that are available to attach. Call this first if the user refers to a document by name rather than exact filename.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      if (!fs.existsSync(INBOX)) return { inbox: INBOX, mounted: false, files: [] };
      const walk = (dir, rel = "") =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
          const r = rel ? `${rel}/${d.name}` : d.name;
          if (d.isDirectory()) return walk(path.join(dir, d.name), r);
          const st = fs.statSync(path.join(dir, d.name));
          return [{
            file: r,
            sizeBytes: st.size,
            sizeMB: +(st.size / 1048576).toFixed(2),
            modified: st.mtime.toISOString(),
            tooLarge: st.size > MAX_UPLOAD_MB * 1048576,
          }];
        });
      return { inbox: INBOX, mounted: true, maxUploadMB: MAX_UPLOAD_MB, files: walk(INBOX) };
    },
  },
  {
    name: "upload_attachment",
    description:
      "Attach a document or photo from the inbox to an item or location. 'file' is a filename from list_inbox, not a host path. Use type=receipt for proofs of purchase, manual for user guides, warranty for warranty docs, photo for images of the item itself.",
    inputSchema: {
      type: "object",
      properties: {
        id: S("Entity ID to attach to (from search_entities or entity_tree)"),
        file: S("Filename inside the inbox, e.g. 'dishwasher-receipt.pdf'"),
        name: S("Display name in Homebox, including extension. Defaults to the filename."),
        type: {
          type: "string",
          enum: ATTACHMENT_TYPES,
          description: "Attachment type (default: attachment)",
        },
        primary: B("Make this the item's primary image (photo type only)"),
      },
      required: ["id", "file"],
    },
    run: async (a) => {
      const full = inboxPath(a.file);
      const size = fs.statSync(full).size;
      if (size > MAX_UPLOAD_MB * 1048576) {
        throw new Error(
          `'${a.file}' is ${(size / 1048576).toFixed(1)}MB; Homebox accepts at most ${MAX_UPLOAD_MB}MB.`
        );
      }
      if (a.type && !ATTACHMENT_TYPES.includes(a.type)) {
        throw new Error(`type must be one of: ${ATTACHMENT_TYPES.join(", ")}`);
      }
      const display = a.name || path.basename(full);
      const form = new FormData();
      form.append("file", new Blob([fs.readFileSync(full)], { type: mimeFor(display) }), display);
      form.append("name", display);
      form.append("type", a.type || "attachment");
      if (a.primary !== undefined) form.append("primary", String(!!a.primary));
      const res = await apiUpload(`/entities/${a.id}/attachments`, form);
      return { uploaded: display, sizeBytes: size, type: a.type || "attachment", entity: res };
    },
  },
  {
    name: "delete_attachment",
    description: "Remove an attachment from an item or location. Attachment IDs come from get_entity.",
    inputSchema: {
      type: "object",
      properties: { id: S("Entity ID"), attachmentId: S("Attachment ID") },
      required: ["id", "attachmentId"],
    },
    run: (a) => api("DELETE", `/entities/${a.id}/attachments/${a.attachmentId}`),
  },
  {
    name: "link_external_attachment",
    description:
      "Attach a reference to a document stored elsewhere (no file is uploaded or copied into Homebox). Use when the document lives in another system and you only want a pointer to it.",
    inputSchema: {
      type: "object",
      properties: {
        id: S("Entity ID"),
        title: S("Display title for the link"),
        externalId: S("Identifier in the source system"),
        sourceType: S("Name of the source system, e.g. 'paperless'"),
        attachmentType: {
          type: "string",
          enum: ATTACHMENT_TYPES,
          description: "Attachment type (default: attachment)",
        },
      },
      required: ["id", "title"],
    },
    run: (a) =>
      api("POST", `/entities/${a.id}/attachments/external`, {
        title: a.title,
        external_id: a.externalId ?? "",
        source_type: a.sourceType ?? "",
        attachment_type: a.attachmentType || "attachment",
      }),
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
      serverInfo: { name: "homebox-shim", version: VERSION },
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

const MCP_TOKEN = process.env.MCP_AUTH_TOKEN ? process.env.MCP_AUTH_TOKEN.trim() : null;

function hasValidMcpAuth(req) {
  if (!MCP_TOKEN) return true;
  const supplied = req.headers.authorization ?? req.headers["x-mcp-token"] ?? req.headers["x-homebox-mcp-token"];
  if (!supplied) return false;
  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  const token = value.startsWith("Bearer ") ? value.slice(7).trim() : value.trim();
  return token === MCP_TOKEN;
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
    return send(200, { ok: true, server: "homebox-shim", version: VERSION, tools: PUBLIC.length });
  }
  if (req.method !== "POST") return send(405, { error: "method not allowed" });
  if (!hasValidMcpAuth(req)) {
    return send(401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "authentication required" } });
  }

  const declaredLength = Number(req.headers["content-length"] || "0");
  if (declaredLength > MAX_REQUEST_BYTES) {
    return send(413, { jsonrpc: "2.0", id: null, error: { code: -32000, message: `request body exceeds ${MAX_REQUEST_BYTES} bytes` } });
  }

  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > MAX_REQUEST_BYTES) {
      req.destroy(new Error(`request body exceeds ${MAX_REQUEST_BYTES} bytes`));
    }
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

server.keepAliveTimeout = 5000;
server.headersTimeout = 15000;

if (process.argv.includes("--doctor")) {
  const status = await preflightCheck();
  console.error(JSON.stringify({ event: "doctor", ok: status.ok, reason: status.reason ?? "ok" }));
  process.exit(status.ok ? 0 : 1);
}

server.listen(PORT, "0.0.0.0", () =>
  console.error(`homebox-shim ${VERSION} listening on :${PORT}/mcp -> ${BASE} (${PUBLIC.length} tools)`)
);
