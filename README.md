# Homebox-Shim

Stateless streamable-HTTP MCP server for [Homebox](https://github.com/sysadminsmedia/homebox),
zero runtime dependencies. Targets the Homebox v0.26.x *entity* API, where items and
locations are unified as "entities" and labels are renamed "tags".

Not to be confused with the third-party `homebox-mcp`, which is read-only.

## Source recovery

This repo was created after discovering the Shim had **no source on disk** — the only copy
of `index.mjs` lived inside the running Docker image, with no Dockerfile. It was recovered
with `docker cp Homebox-Shim:/app/index.mjs` and the Dockerfile reconstructed from the
image's config. This repo is now the source of truth; rebuild from here.

## Build & run

```bash
docker build -t homebox-shim:latest .
docker run -d --name Homebox-Shim -p 3334:3334 \
  -v /mnt/user/applications/appdata/homebox-shim/config:/config:rw \
  -v /mnt/user/applications/appdata/homebox-shim/inbox:/inbox:ro \
  homebox-shim:latest
```

## Configuration

`/config/config.json` (or `HOMEBOX_URL` + `HOMEBOX_API_KEY`, or URL + email/password):

```json
{ "homeboxUrl": "http://homebox:7745", "apiKey": "..." }
```

| Env | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3334` | Listen port |
| `CONFIG_PATH` | `/config/config.json` | Config file |
| `INBOX_PATH` | `/inbox` | Read-only upload staging dir |
| `MAX_UPLOAD_MB` | `10` | Must match Homebox's `HBOX_WEB_MAX_UPLOAD_SIZE` |

## Tools (16)

**Read** — `search_entities`, `entity_tree`, `get_entity`, `list_tags`,
`list_entity_types`, `get_stats`

**Write** — `create_location`, `create_item`, `update_entity`, `move_entity`,
`delete_entity`, `create_tag`

**Attachments** — `list_inbox`, `upload_attachment`, `delete_attachment`,
`link_external_attachment`

## Attachments

MCP tool calls carry JSON, not binary, so files reach the Shim through the read-only
inbox mount rather than inline base64 (a 10 MB file would be ~13 MB of base64 in the
model's context). Drop a file in the inbox, then attach it by filename.

Paths are resolved against the inbox and rejected if they escape it, so `../../etc/passwd`
and absolute paths both fail closed. Oversize files are rejected before upload with the
actual size rather than an opaque 422.

Valid types: `attachment`, `photo`, `manual`, `warranty`, `receipt`, `thumbnail`.
