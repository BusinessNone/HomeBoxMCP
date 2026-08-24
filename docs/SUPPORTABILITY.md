# Supportability Review — HomeBoxMCP

**Date:** 2026-08-24
**Reviewed revision:** `327fa47` (initial commit)

## Scope note

This review was requested as an examination of the existing project. At the reviewed
revision the repository contains only `LICENSE` and a one-line `README.md` — there is no
source code, build, dependency manifest, or CI configuration to audit. Nothing below is a
finding against existing code; it is a supportability baseline to put in place before the
first feature lands, when it is cheap to do so.

The recommendations assume the project's evident intent: an [MCP](https://modelcontextprotocol.io)
server exposing [HomeBox](https://homebox.software/) (self-hosted home inventory) to LLM
clients. Where that assumption drives a recommendation, it is called out.

Supportability here means: when a user reports "it doesn't work," how quickly can a
maintainer reproduce, diagnose, and ship a fix — without access to that user's machine?

---

## Priority 1 — Blocks all diagnosis

### 1.1 Nothing in the repo says what this is or how to run it

`README.md` is `# HomeBoxMCP`. A user cannot install it, and a maintainer receiving a bug
report has no shared vocabulary for "what version, configured how."

**Recommend** the README carry, in this order: one-sentence description; supported HomeBox
versions; install/run for each supported path (npx/uvx, Docker, from source); a complete
minimal client config block (Claude Desktop / Claude Code `mcp.json`); the full environment
variable table; and a Troubleshooting section. Everything else can move to `docs/`.

### 1.2 No version identity

An MCP server is distributed software running on other people's machines. Without a version
string surfaced at runtime, every bug report starts with an unanswerable question.

**Recommend:**
- Semantic versioning, single source of truth in the package manifest.
- The server reports its version in the MCP `initialize` response `serverInfo.version`,
  and logs `name@version` plus runtime version on startup.
- A `CHANGELOG.md` (Keep a Changelog format), updated in the same PR as the change.
- Git tags on release, matching the published artifact version exactly.

### 1.3 No structured diagnostics

For a stdio-transport MCP server this is the single highest-leverage supportability
investment, because **stdout is the protocol channel**. Anything written to stdout that is
not a JSON-RPC message corrupts the session, and the failure surfaces to the user as an
opaque client-side disconnect.

**Recommend:**
- All logging to **stderr**, never stdout. Enforce this with a lint rule banning bare
  `console.log` / `print` outside a logging module, so it cannot regress.
- Structured JSON lines: `timestamp`, `level`, `event`, `tool`, `request_id`, `duration_ms`.
- `LOG_LEVEL` env var (`error|warn|info|debug`), default `info`.
- At `debug`, log every tool invocation and the HomeBox HTTP call it produced: method, path,
  status, latency — **never** the bearer token or request/response bodies containing
  inventory data.
- A documented way for a user to capture a log file and attach it to an issue.

---

## Priority 2 — Determines how often you get a bug report at all

### 2.1 Configuration validation and startup failure messages

The predictable support load for this project is misconfiguration: wrong HomeBox URL, expired
credentials, a HomeBox instance behind a reverse proxy or self-signed cert. Each of these
should produce one actionable sentence, not a stack trace.

**Recommend:**
- Validate all config at startup against a schema, before serving requests. Fail fast with a
  message naming the offending variable and what was expected.
- An explicit connectivity preflight against HomeBox on startup (e.g. `/api/v1/status`),
  distinguishing *unreachable* (DNS/refused/TLS) from *reachable but unauthorized* (401) —
  these have completely different fixes and users cannot tell them apart.
- A `--doctor` / `--check-config` flag that runs the preflight and exits, so a user can
  self-diagnose without involving their MCP client at all. This deflects a large share of
  issues.

### 2.2 HomeBox authentication is a support liability

HomeBox authenticates by POSTing credentials to `/api/v1/users/login` for a bearer token
([docs](https://homebox.software/en/api/)). Two consequences:

- **Token expiry** must be handled by transparent re-authentication with backoff. If it is
  not, the server works for an hour and then mysteriously stops — the worst possible failure
  shape to support.
- **Credentials in config** means users will paste them into issues and logs. Redact secrets
  centrally at the logger, not at each call site, and never echo config values back in error
  messages.

Prefer HomeBox API keys over username/password if the target version supports them
([discussion](https://github.com/sysadminsmedia/homebox/discussions/539)); document the
minimum HomeBox version for each auth mode.

### 2.3 Pin the HomeBox API contract

HomeBox publishes an OpenAPI 3.0.0 spec. Hand-written HTTP calls against a moving upstream
produce the hardest class of bug to support: a silent breakage that only reproduces against
one HomeBox version.

**Recommend** generating the HomeBox client from the vendored OpenAPI spec, committing the
spec, and stating a supported-version range in the README. When upstream changes, the
generated diff tells you immediately what broke.

### 2.4 Error handling contract for tools

MCP tool errors are read by a model and then paraphrased to a human. Vague errors become
vague user reports.

**Recommend** a single error-mapping layer: HomeBox 4xx/5xx, network, and validation failures
each map to a distinct, actionable tool-error message that names the failing tool and the
likely user-side fix. Never let a raw exception or stack trace become the tool result.

---

## Priority 3 — Keeps the project supportable by more than one person

### 3.1 CI from the first commit

**Recommend** a GitHub Actions workflow on push/PR running: install, lint, typecheck, test —
across every runtime version and OS the README claims to support. A support claim that CI
does not exercise will eventually be false.

### 3.2 Tests targeted at the support surface

Coverage percentage is not the goal; reproducibility is. Prioritize:
- Contract tests per tool against a mocked HomeBox (fixtures derived from the OpenAPI spec).
- Failure-path tests: 401, 5xx, timeout, malformed JSON, token expiry mid-session.
- A **stdout-purity test** asserting no non-protocol bytes reach stdout during a full session.
  This guards the failure mode from §1.3 that is otherwise invisible until a user hits it.

### 3.3 Contribution and issue intake

**Recommend:** `CONTRIBUTING.md` (dev setup, how to run against a local HomeBox in Docker,
test/lint commands); a bug-report issue template that *requires* HomeBoxMCP version, HomeBox
version, MCP client, OS, and log excerpt — this is where §1.2 and §1.3 pay off; a
`SECURITY.md` with a private reporting path, since this software holds credentials to a
user's home inventory.

### 3.4 Repository conventions for AI-assisted work

**Recommend** a `CLAUDE.md` recording build/test/lint commands, the stdout-is-protocol
constraint, the logging and error-mapping conventions, and the secret-redaction rule — so
agent-authored changes do not silently violate the invariants above.

---

## Suggested sequence

| Step | Work | Why first |
|------|------|-----------|
| 1 | README, versioning, CHANGELOG | Nothing else is diagnosable without these |
| 2 | stderr-only structured logging + lint guard + stdout-purity test | Prevents the highest-severity, hardest-to-diagnose failure |
| 3 | Config schema validation, connectivity preflight, `--doctor` | Deflects the largest expected support category |
| 4 | Vendored OpenAPI spec + generated client | Pins the contract before code depends on assumptions |
| 5 | Central error mapping + secret redaction | Makes user reports actionable and safe |
| 6 | CI matrix, failure-path tests | Keeps 1–5 from regressing |
| 7 | CONTRIBUTING, SECURITY, issue templates, CLAUDE.md | Scales past one maintainer |

Steps 1–3 are the ones that change whether a bug report is answerable at all; they are
substantially cheaper now than after the tool surface exists.

## References

- [HomeBox](https://homebox.software/) — [API overview](https://homebox.software/en/api/)
- [sysadminsmedia/homebox](https://github.com/sysadminsmedia/homebox) — active continuation of the project
- [HomeBox API key discussion](https://github.com/sysadminsmedia/homebox/discussions/539)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [Keep a Changelog](https://keepachangelog.com/)
