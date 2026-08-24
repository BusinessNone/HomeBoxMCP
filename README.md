# HomeBoxMCP

**Talk to your home inventory.** HomeBoxMCP is a small, stateless MCP server that puts your
[Homebox](https://github.com/sysadminsmedia/homebox) inventory in reach of any MCP client —
Claude, or anything else that speaks the protocol. Ask where the drill is, file a new
purchase with its receipt attached, or reorganize a whole closet, in plain language.

```
"Where did I put the spare HDMI cables?"
"Add the new espresso machine to the kitchen — warranty expires 2028-04-01."
"Move everything on Shelf B to the garage overflow bin."
```

Sixteen tools, one file, **zero runtime dependencies** — just Node 22 and `node:http`.
Drop it behind Docker and forget about it.

## Why this one

- **Read *and* write.** Not to be confused with the third-party read-only `homebox-mcp`.
  This one creates, updates, moves, deletes, and attaches files.
- **Built for Homebox v0.26.x.** Targets the *entity* API, where items and locations are
  unified as "entities" and labels are renamed "tags".
- **Stateless streamable HTTP.** No session store, no database, no sidecar. Restart it
  whenever you like.
- **Fails loudly, not weirdly.** `--doctor` validates your Homebox connection before the
  server ever accepts a request, and oversize uploads are rejected with the actual size
  instead of an opaque 422.

## Quick start

```bash
docker build -t homebox-shim:latest .
docker run -d --name Homebox-Shim -p 3334:3334 \
  -v /path/to/config:/config:rw \
  -v /path/to/inbox:/inbox:ro \
  homebox-shim:latest
```

Point your MCP client at `http://your-host:3334/mcp`. Check it's alive with
`curl http://your-host:3334/healthz`, which reports the version and tool count.

Prefer to sanity-check the config first?

```bash
docker run --rm -v /path/to/config:/config:ro homebox-shim:latest \
  node /app/index.mjs --doctor
```

## Configuration

Write `/config/config.json`:

```json
{ "homeboxUrl": "http://homebox:7745", "apiKey": "..." }
```

Or skip the file entirely and use `HOMEBOX_URL` plus `HOMEBOX_API_KEY` — or
`HOMEBOX_URL` with email and password, if you'd rather the Shim log in for itself.

| Env | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3334` | Listen port |
| `CONFIG_PATH` | `/config/config.json` | Config file |
| `INBOX_PATH` | `/inbox` | Read-only upload staging dir |
| `MAX_UPLOAD_MB` | `10` | Must match Homebox's `HBOX_WEB_MAX_UPLOAD_SIZE` |
| `MCP_AUTH_TOKEN` | unset | Bearer token required on every MCP request |
| `MAX_REQUEST_BYTES` | `4000000` | Maximum accepted JSON-RPC request size |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, or `debug` |

If you expose the Shim beyond your own machine, set `MCP_AUTH_TOKEN`. Clients may send it
as `Authorization: Bearer <token>`, `X-MCP-Token`, or `X-Homebox-MCP-Token`.

## The 16 tools

**Read** — `search_entities`, `entity_tree`, `get_entity`, `list_tags`,
`list_entity_types`, `get_stats`

**Write** — `create_location`, `create_item`, `update_entity`, `move_entity`,
`delete_entity`, `create_tag`

**Attachments** — `list_inbox`, `upload_attachment`, `delete_attachment`,
`link_external_attachment`

## Attachments, and why there's an inbox

MCP tool calls carry JSON, not binary. Inlining a 10 MB receipt as base64 would burn
~13 MB of the model's context to move one file. So files reach the Shim through a
read-only inbox mount instead: drop the file in the inbox, then attach it by filename.

Paths resolve against the inbox and are rejected if they try to escape it — `../../etc/passwd`
and absolute paths both fail closed. Valid attachment types are `attachment`, `photo`,
`manual`, `warranty`, `receipt`, and `thumbnail`.

## Origin story

This repo exists because the Shim was discovered running with **no source on disk** — the
only copy of `index.mjs` lived inside a running Docker image, with no Dockerfile anywhere.
It was recovered with `docker cp Homebox-Shim:/app/index.mjs` and the Dockerfile
reconstructed from the image's own config. This repo is now the source of truth. Rebuild
from here, not from the image.

See [`docs/SUPPORTABILITY.md`](docs/SUPPORTABILITY.md) for the review that prompted the
recovery.

## License

MIT — see [LICENSE](LICENSE).
