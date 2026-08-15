# Agent Run Logger

[中文](README.zh.md) | English

Agent Run Logger is a DeepSeek Harness plugin that writes a compact local JSONL trace for each live Session. It turns low-level Session events into run, step, model, and tool timing records that are easier to inspect than the canonical conversation log.

Each Session writes to its own file under `<session cwd>/.dsh/traces/` by default. Records are appended while the Agent runs. Writers preserve source-event order inside one Session and drain independently across concurrent Sessions.

By default the trace contains metadata, identifiers, timings, outcomes, and token usage, but no prompt, reply, tool arguments, or tool results. Set `includeContent: true` to capture those values. Each captured value is limited to 64 KiB by default; oversized JSON is represented by UTF-8-safe head and tail previews without modifying the Session log.

The event path never waits for disk I/O. Each Session has a bounded 4 MiB queue by default. When that queue is full, new trace records are dropped and a later `trace.gap` record reports the affected source sequence range. A directory, write, or sync failure warns once and disables only that Session writer.

## Install from a tarball

Build and pack the plugin, then install the generated archive into a profile:

```sh
pnpm install
pnpm pack
dsh plugin --profile trace-demo add ./dsh-agent-run-logger-0.1.0.tgz
dsh --profile trace-demo --dump-config
dsh --profile trace-demo
```

The bundle adds this row, which a profile patch may replace:

```yaml
- id: agent-run-logger
  name: dsh-agent-run-logger
  config:
    outputDir: .dsh/traces
    includeContent: false
    maxContentBytes: 65536
    maxPendingBytes: 4194304
```

`outputDir` may be absolute or relative to each Session working directory. `maxContentBytes` and `maxPendingBytes` are positive byte counts.

## Record types

The schema version is `1`. The plugin writes `session.meta`, `run.start`, `run.end`, `step.start`, `step.end`, `llm.first_token`, `llm.end`, `tool.start`, `tool.end`, and `trace.gap`. Every record includes `sessionId`, `sourceSeq`, and `time`.

## Limitations

- It observes only events committed after the plugin activates; it does not backfill existing Session history.
- A turn is one run. Subagent Sessions remain separate files; `parentSessionId` records lineage, but the plugin does not build a cross-Session call tree.
- It has no viewer, query API, remote exporter, OpenTelemetry integration, file rotation, or retention policy.
- `includeContent: true` may store sensitive information. Truncation limits each captured value, not the total trace file size.
- `run.end` and plugin disposal request a filesystem sync, but an operating-system or power failure may still lose an unsynced tail.
- Trace files are diagnostics, not a replacement for the canonical DeepSeek Harness Session log.
