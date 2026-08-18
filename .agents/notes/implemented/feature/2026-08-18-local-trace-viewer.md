# Agent Note: Keep trace recording and local visualization in one bundle

Status: implemented

English | [中文](2026-08-18-local-trace-viewer.zh.md)

## Problem

Agent Run Logger needs a useful visual inspection surface without turning local diagnostic traces into a remote service or making recording depend on a viewer process. Large append-only JSONL files, concurrent Sessions, and optional captured content also require bounded memory use and explicit filesystem and network safety.

## Decision

`dsh-agent-run-logger` remains one npm bundle. The Cordis plugin projects committed Session events into independent per-Session JSONL files, while the package CLI serves a separate read-only viewer for those files. Recording never depends on the CLI, and the CLI never writes trace data except when the user explicitly enables retention deletion.

The repository incrementally indexes complete appended lines and retains summaries plus byte offsets instead of complete records. Page requests reopen the indexed regular file and verify its identity before reading. File shrink or identity replacement resets that Session in the browser; ordinary append continues from the existing cursor. Parent and child Sessions remain separate timelines connected by recorded lineage.

The HTTP server binds only to loopback, validates the Host header, exposes a closed GET-only route set, caps record pages and SSE subscribers, and disconnects slow subscribers. Startup, polling, and disposal have single owned promises so concurrent lifecycle operations reach quiescence. Content capture remains opt-in; when enabled, configured credential-like values are redacted before bounded UTF-8 truncation and persistence.

## Alternatives considered

**A second viewer package** — rejected because the logger schema, installation patch, CLI, assets, and release version must remain compatible as one installable DeepSeek Harness plugin.

**Loading whole trace files in the browser or server** — rejected because trace files grow continuously and several Sessions may be active concurrently. Incremental offsets bound server memory while paged reads bound each response.

**Remote binding with authentication** — rejected for this version because it expands the threat model and deployment surface. The viewer is intentionally a local diagnostic tool.

**UI-only redaction** — rejected because sensitive values would already exist on disk. Redaction therefore occurs in the recording path before truncation and persistence.

## Consequences

Users install and upgrade one package and can inspect live and historical local traces without changing Agent execution. The design gives up remote access, merged cross-Session timelines, a database, uploads, and OpenTelemetry export. Trace files remain diagnostics rather than the canonical Session log, and redaction reduces accidental credential capture without promising complete secret classification.
