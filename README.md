# Agent Run Logger

[中文](README.zh.md) | English

Agent Run Logger is a DeepSeek Harness plugin that writes compact local JSONL traces and serves a live, read-only viewer. It turns Session events into run, step, model, and tool timing records without replacing the canonical Session log.

Each Session writes to its own file under `<session cwd>/.dsh/traces/` by default. Writers preserve source-event order inside one Session and drain independently across concurrent Sessions. The viewer incrementally indexes those files and presents Session lineage, a timing waterfall, event details, failures, token usage, gaps, and truncated values.

Content capture is off by default. Enabling it records prompts, replies, tool arguments, and tool results after credential-like values are redacted and before each value is truncated to its configured UTF-8 byte limit.

## Install

Install the package directly from npm:

```sh
npm install dsh-agent-run-logger
```

Add the plugin to a DeepSeek Harness profile:

```sh
dsh plugin --profile trace-demo add dsh-agent-run-logger
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
    redactSensitiveContent: true
    redactKeys: []
```

`outputDir` may be absolute or relative to each Session working directory. Byte limits are positive integers. `redactKeys` adds case-insensitive object-key names to the built-in credential list.

## View traces

Run the viewer from the project whose `.dsh/traces` directory you want to inspect:

```sh
npx dsh-agent-run-logger view
```

The command binds to `127.0.0.1`, selects a port beginning at `4318`, and opens the dashboard. It does not accept remote connections.

```text
Usage: dsh-agent-run-logger view [options]

  --trace-dir <path>       Trace directory (default: .dsh/traces)
  --port <number>          Preferred loopback port (default: 4318)
  --poll-ms <number>       Refresh interval (default: 750)
  --page-size <number>     Records returned per page (default: 500)
  --no-open                Print the URL without opening a browser
  --retention-days <days>  Delete old regular JSONL files at startup
```

Retention is disabled unless `--retention-days` is supplied. The viewer otherwise performs read-only filesystem access. See the [viewer design](docs/visualizer-design.md) for data, lifecycle, privacy, and HTTP behavior.

## Record behavior

The trace schema version is `1`. The plugin writes `session.meta`, `run.start`, `run.end`, `step.start`, `step.end`, `llm.first_token`, `llm.end`, `tool.start`, `tool.end`, and `trace.gap`. Every record includes `sessionId`, `sourceSeq`, and `time`.

The Session event path never waits for disk I/O. Each Session has a bounded 4 MiB queue by default. Queue overflow drops new trace records and a later `trace.gap` reports the affected source sequence range. A directory, write, or sync failure warns once and disables only that Session writer.

## Limitations

- The logger observes only events committed after activation; it does not backfill canonical Session history.
- Subagent Sessions remain separate files. The viewer navigates `parentSessionId` relationships when both files are present, but does not merge their timelines.
- The viewer is local only and provides no authentication, remote exporter, trace upload, database, or OpenTelemetry integration.
- Content redaction reduces accidental credential storage but cannot classify every secret. Keep `includeContent: false` unless content is required.
- `run.end` and plugin disposal request a filesystem sync, but an operating-system or power failure may still lose an unsynced tail.
- Trace files are diagnostics, not a replacement for the canonical DeepSeek Harness Session log.
