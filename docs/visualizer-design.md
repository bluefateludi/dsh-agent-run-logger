# Local Trace Viewer Design

[中文](visualizer-design.zh.md) | English

Status: approved for `v0.2.0`

## Purpose

Agent Run Logger remains one DeepSeek Harness plugin and one npm package. Version `0.2.0` adds a local, read-only web viewer without coupling trace recording to a browser process. The Cordis plugin keeps writing JSONL traces; the package CLI reads those files and serves the bundled interface.

The viewer answers four questions: what ran, where time was spent, what failed, and how a child Session relates to its parent. It is a diagnostic surface, not a replacement for the canonical Session log or a remote observability platform.

## User experience

After installing the plugin, a user starts the viewer in a project directory:

```sh
npx dsh-agent-run-logger view
```

The command reads `.dsh/traces`, binds to `127.0.0.1`, selects an available port beginning at `4318`, and opens the browser. `--trace-dir`, `--port`, `--no-open`, and opt-in retention flags cover non-default operation. The CLI prints the exact URL and trace directory before serving.

The page uses a dense flight-recorder aesthetic: a session navigator on the left, a chronological waterfall in the center, and an inspectable event panel on the right. A summary rail reports runs, failures, model time, tool time, token usage, gaps, and truncated values. Keyboard navigation and a narrow-screen detail drawer keep the same information available without pointer-only interaction.

## Package structure

The npm package exposes two entry points:

- The existing default export is the Cordis logger plugin.
- The `dsh-agent-run-logger` binary owns `view`, help, and version commands.

The package contains one implementation with four deep modules:

1. `RunTraceProjector` converts Session events into schema-versioned records.
2. `TraceRepository` indexes trace files incrementally and answers summary or paged-record queries.
3. `ViewerServer` owns loopback HTTP, static assets, Server-Sent Events, and teardown.
4. The browser application renders repository results and never reads the filesystem directly.

Only `TraceRepository` knows filenames, byte offsets, partial lines, malformed rows, and append detection. Only `ViewerServer` knows routes, headers, host validation, and connected SSE clients. The UI depends on JSON response fields rather than Node modules.

## Trace repository interface

The external interface stays small:

```ts
interface TraceRepository {
  refresh(): Promise<TraceChangeSet>
  list(query?: SessionQuery): readonly SessionSummary[]
  detail(key: string): SessionDetail | undefined
  records(key: string, page: RecordPageRequest): Promise<RecordPage>
}
```

`refresh()` scans directory metadata and reads only newly appended bytes. It stores summaries and line byte offsets, not every complete record. `records()` opens one selected file and reads at most the requested page. A partial final line remains pending until a newline arrives. A file that shrinks or changes identity is re-indexed. A malformed complete line is reported as a diagnostic and does not hide later valid lines.

The stable viewer key is the validated base64url filename stem, not a user-provided path. The repository never joins an unvalidated request value onto the trace directory.

Schema version `1` remains readable. Unknown record types and additional fields are preserved for raw inspection and shown as generic timeline events. Unsupported schema versions appear as incompatible sessions instead of being guessed.

## Local HTTP interface

The server provides only idempotent reads:

- `GET /api/sessions` returns filtered summaries and aggregate counts.
- `GET /api/sessions/:key` returns metadata, lineage, diagnostics, and run summaries.
- `GET /api/sessions/:key/records?cursor=0&limit=500` returns a bounded record page.
- `GET /api/events` streams `snapshot`, `trace.changed`, and heartbeat events.
- `GET /`, `/app.js`, and `/styles.css` return bundled assets.

JSON errors contain a stable code and a concise correction. Record page limits are clamped to a configured maximum. Responses disable caching for live data and use immutable caching only for versioned static assets.

The server polls the repository at a bounded interval rather than relying on `fs.watch`, whose behavior differs across platforms. One poll runs at a time. A slow refresh cannot overlap the next tick. SSE dispatch contains subscriber failures so one disconnected browser cannot affect indexing or other clients.

Shutdown closes the polling loop and SSE registry before awaiting the HTTP server. The CLI handles `SIGINT` and `SIGTERM` once and reaches quiescence before exiting.

## Visualization model

The session list groups children beneath parents when both traces are present. Missing parents remain explicit external-parent links. The viewer does not merge files or invent cross-Session timing; it presents lineage and lets users navigate between independent Session timelines.

The waterfall derives rows from stable identifiers:

- `run.start` and `run.end` form run spans.
- `step.start` and `step.end` form step spans.
- `llm.first_token` and `llm.end` expose time-to-first-token and model duration.
- `tool.start` and `tool.end` form tool spans and show independent parallel calls.
- `trace.gap`, malformed lines, incomplete pairs, and truncated content render warning markers.

Open spans extend to the latest observed trace time and carry a live state. Negative or missing durations never produce negative geometry. Raw timestamps and recorded durations remain visible so the derived chart is auditable.

## Privacy and security

The viewer binds only to IPv4 or IPv6 loopback addresses. Remote binding is not supported in `v0.2.0`. The server validates the `Host` header against loopback names and the bound port, emits no permissive CORS headers, and sends a restrictive Content Security Policy.

Static file routing uses a closed asset map. Trace keys accept base64url characters only. The browser renders trace values through text nodes; trace content is never assigned to HTML.

Content capture remains off by default. When content exists, the details panel starts collapsed and displays a sensitivity notice. Redaction occurs before persistence, not only in the UI. Default redaction covers credential-like object keys and common authorization-token strings; deployments may add key names. Truncation runs after redaction.

Retention is opt-in. `--retention-days` removes only regular `.jsonl` files inside the resolved trace directory whose modification time is older than the cutoff. The command reports each removal, refuses symlinks and junctions, and never recursively deletes directories. With no retention option, the viewer is strictly read-only.

## Configuration

Logger configuration adds:

- `redactSensitiveContent`, default `true` when content capture is enabled.
- `redactKeys`, additional case-insensitive object-key names.

Viewer CLI configuration includes:

- `--trace-dir <path>`, default `.dsh/traces` under the current directory.
- `--port <number>`, default search begins at `4318`.
- `--poll-ms <number>`, default `750`, with a safe lower bound.
- `--page-size <number>`, default `500`, with a hard maximum.
- `--no-open`, disables browser launch.
- `--retention-days <number>`, absent by default.

All self-contained invalid configuration fails before the server listens.

## Failure behavior

A missing trace directory produces an empty dashboard and begins polling for its creation. Permission failures and invalid trace files appear in the CLI and dashboard diagnostics without terminating healthy sessions. A port collision advances through a small deterministic range before failing with a correction. Browser-launch failure prints the URL and leaves the server running.

The viewer never changes Agent execution. Logger write failures remain isolated per Session. Viewer read or rendering failures cannot disable recording.

## Verification

Unit tests cover incremental UTF-8 reads, partial lines, truncation and replacement, malformed rows, schema rejection, paging, lineage, redaction, route validation, Host validation, SSE limits and disconnects, startup races, and idempotent disposal. Static UI checks ensure JavaScript DOM references exist in the packaged HTML, local assets stay self-contained, and trace rendering does not use HTML injection APIs.

A release smoke starts the built CLI from an installed tarball, requests its real HTTP routes, and terminates it without leaving the listener behind. Interactive browser QA verifies the session list, waterfall, filters, keyboard selection, warning states, responsive drawer, and safe rendering of HTML-like trace content.

Packaging verification installs the generated tarball into a clean directory, runs `dsh-agent-run-logger view --no-open`, requests the dashboard, and confirms the existing Cordis logger tests still record a complete trace. After publication, the same smoke is repeated against the npm version.

## Delivery and acceptance

The implementation remains in `dsh-agent-run-logger` and releases as `0.2.0`. No companion npm package, remote collector, authentication system, database, trace upload, or OpenTelemetry exporter is part of this version.

The version is complete when a clean npm install can record traces and start the local viewer; historical and appended records appear without a full-file reload; parent and child Sessions are navigable; sensitive content is collapsed and redacted before disk; the server is unreachable through non-loopback Host values; all owned processes and connections close on disposal; and GitHub/npm artifacts pass the same clean-install smoke.
