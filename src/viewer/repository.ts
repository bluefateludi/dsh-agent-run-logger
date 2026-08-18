import type { Stats } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

const TRACE_FILENAME = /^([A-Za-z0-9_-]+)\.jsonl$/
const SUPPORTED_SCHEMA_VERSION = 1

/** A problem found while discovering or indexing trace data. */
export interface TraceDiagnostic {
  readonly code: 'directory-unreadable' | 'file-unreadable' | 'malformed-line' | 'invalid-record' | 'unsupported-schema'
  readonly message: string
  readonly line?: number
  readonly byteOffset?: number
}

/** Summary data used to navigate one independently recorded Session. */
export interface SessionSummary {
  readonly key: string
  readonly sessionId?: string
  readonly parentSessionId?: string
  readonly createdAt?: number
  readonly firstTime?: number
  readonly lastTime?: number
  readonly recordCount: number
  readonly runCount: number
  readonly failureCount: number
  readonly modelTimeMs: number
  readonly toolTimeMs: number
  readonly totalTokens: number
  readonly gapCount: number
  readonly truncatedValueCount: number
  readonly diagnosticCount: number
  readonly incompatible: boolean
}

/** Optional filters for the Session navigator. */
export interface SessionQuery {
  readonly search?: string
  readonly failuresOnly?: boolean
}

/** One run derived from the trace's stable run identifier. */
export interface RunSummary {
  readonly runId: string
  readonly startedAt?: number
  readonly endedAt?: number
  readonly outcome?: string
  readonly durationMs?: number
}

/** Resolved parent and child navigation without merging trace timelines. */
export interface SessionLineage {
  readonly parent?: { readonly key?: string; readonly sessionId: string }
  readonly children: readonly { readonly key: string; readonly sessionId: string }[]
}

/** Repository detail for one Session. */
export interface SessionDetail {
  readonly summary: SessionSummary
  readonly lineage: SessionLineage
  readonly diagnostics: readonly TraceDiagnostic[]
  readonly runs: readonly RunSummary[]
}

/** A bounded page of preserved JSON trace objects. */
export interface RecordPage {
  readonly records: readonly Readonly<Record<string, unknown>>[]
  readonly cursor: number
  readonly nextCursor?: number
  readonly total: number
}

/** Zero-based page request. The repository clamps limit to its configured maximum. */
export interface RecordPageRequest {
  readonly cursor?: number
  readonly limit?: number
}

/** Observable result of one directory refresh. */
export interface TraceChangeSet {
  readonly changed: readonly string[]
  readonly reset?: readonly string[]
  readonly removed: readonly string[]
  readonly diagnostics: readonly TraceDiagnostic[]
}

/** Construction options for an incremental trace repository. */
export interface TraceRepositoryOptions {
  readonly traceDirectory: string
  readonly maximumPageSize?: number
  readonly defaultPageSize?: number
}

interface LineOffset {
  readonly start: number
  readonly end: number
  readonly line: number
}

interface MutableRunSummary {
  runId: string
  startedAt?: number
  endedAt?: number
  outcome?: string
  durationMs?: number
}

interface FileIndex {
  readonly key: string
  readonly path: string
  identity: string
  size: number
  readOffset: number
  pending: Buffer
  pendingStart: number
  nextLine: number
  offsets: LineOffset[]
  diagnostics: TraceDiagnostic[]
  summary: SessionSummary
  runs: Map<string, MutableRunSummary>
}

/** Incrementally index JSONL traces while retaining only summaries and byte offsets. */
export class TraceRepository {
  private readonly traceDirectory: string
  private readonly maximumPageSize: number
  private readonly defaultPageSize: number
  private readonly files = new Map<string, FileIndex>()

  constructor(options: TraceRepositoryOptions) {
    if (options.traceDirectory.length === 0) throw new Error('traceDirectory must not be empty')
    this.maximumPageSize = positiveInteger(options.maximumPageSize ?? 2_000, 'maximumPageSize')
    this.defaultPageSize = positiveInteger(options.defaultPageSize ?? 500, 'defaultPageSize')
    if (this.defaultPageSize > this.maximumPageSize) {
      throw new Error('defaultPageSize must not exceed maximumPageSize')
    }
    this.traceDirectory = options.traceDirectory
  }

  /** Discover trace files and index only bytes appended since the prior refresh. */
  async refresh(): Promise<TraceChangeSet> {
    let entries
    try {
      entries = await readdir(this.traceDirectory, { withFileTypes: true })
    } catch (error: unknown) {
      if (isMissing(error)) return this.removeAll([])
      return {
        changed: [],
        removed: [],
        reset: [],
        diagnostics: [{ code: 'directory-unreadable', message: `Cannot read trace directory: ${errorMessage(error)}` }],
      }
    }

    const discovered = new Map<string, string>()
    for (const entry of entries) {
      const match = TRACE_FILENAME.exec(entry.name)
      if (entry.isFile() && match?.[1] !== undefined) discovered.set(match[1], join(this.traceDirectory, entry.name))
    }

    const changed: string[] = []
    const reset: string[] = []
    const diagnostics: TraceDiagnostic[] = []
    for (const [key, path] of discovered) {
      let handle: FileHandle | undefined
      try {
        const opened = await openValidatedRegularFile(path)
        handle = opened.handle
        const metadata = opened.metadata
        const identity = fileIdentity(metadata)
        let index = this.files.get(key)
        const isNew = index === undefined
        const replaced = index !== undefined && (index.identity !== identity || metadata.size < index.size)
        if (index === undefined || replaced) {
          index = emptyIndex(key, path, identity)
          this.files.set(key, index)
        }
        if (metadata.size !== index.size) {
          await this.append(index, handle, metadata.size)
          changed.push(key)
        }
        if (isNew || replaced) changed.push(key)
        if (replaced) reset.push(key)
      } catch (error: unknown) {
        const diagnostic: TraceDiagnostic = {
          code: 'file-unreadable',
          message: `Cannot index ${key}.jsonl: ${errorMessage(error)}`,
        }
        diagnostics.push(diagnostic)
        const index = this.files.get(key)
        if (index !== undefined) addDiagnostic(index, diagnostic)
      } finally {
        await handle?.close()
      }
    }

    const removed: string[] = []
    for (const key of this.files.keys()) {
      if (!discovered.has(key)) {
        this.files.delete(key)
        removed.push(key)
      }
    }
    return { changed: unique(changed), reset: unique(reset), removed, diagnostics }
  }

  /** Return immutable Session summaries sorted with the newest observation first. */
  list(query: SessionQuery = {}): readonly SessionSummary[] {
    const search = query.search?.trim().toLocaleLowerCase()
    return [...this.files.values()]
      .map((file) => file.summary)
      .filter((summary) => !query.failuresOnly || summary.failureCount > 0)
      .filter((summary) => search === undefined || search.length === 0
        || summary.key.toLocaleLowerCase().includes(search)
        || summary.sessionId?.toLocaleLowerCase().includes(search) === true)
      .sort((left, right) => (right.lastTime ?? -Infinity) - (left.lastTime ?? -Infinity) || left.key.localeCompare(right.key))
  }

  /** Resolve metadata, diagnostics, runs, and navigable lineage for one validated key. */
  detail(key: string): SessionDetail | undefined {
    if (!validKey(key)) return undefined
    const file = this.files.get(key)
    if (file === undefined) return undefined
    const sessionId = file.summary.sessionId
    const parentSessionId = file.summary.parentSessionId
    const parentFile = parentSessionId === undefined ? undefined : this.fileBySessionId(parentSessionId)
    const children = sessionId === undefined ? [] : [...this.files.values()]
      .filter((candidate) => candidate.summary.parentSessionId === sessionId && candidate.summary.sessionId !== undefined)
      .map((candidate) => ({ key: candidate.key, sessionId: candidate.summary.sessionId as string }))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
    return {
      summary: file.summary,
      lineage: {
        ...(parentSessionId === undefined ? {} : {
          parent: { ...(parentFile === undefined ? {} : { key: parentFile.key }), sessionId: parentSessionId },
        }),
        children,
      },
      diagnostics: file.diagnostics,
      runs: [...file.runs.values()].map((run) => ({ ...run })),
    }
  }

  /** Read one bounded page directly from the selected trace file. */
  async records(key: string, request: RecordPageRequest): Promise<RecordPage> {
    if (!validKey(key)) return { records: [], cursor: 0, total: 0 }
    const file = this.files.get(key)
    if (file === undefined) return { records: [], cursor: 0, total: 0 }
    const cursor = nonNegativeInteger(request.cursor ?? 0, 'cursor')
    const limit = Math.min(positiveInteger(request.limit ?? this.defaultPageSize, 'limit'), this.maximumPageSize)
    const selected = file.offsets.slice(cursor, cursor + limit)
    if (selected.length === 0) return { records: [], cursor, total: file.offsets.length }

    const opened = await openValidatedRegularFile(file.path, file.identity)
    const handle = opened.handle
    try {
      const start = selected[0]!.start
      const end = selected.at(-1)!.end
      const bytes = Buffer.alloc(end - start)
      const result = await handle.read(bytes, 0, bytes.length, start)
      if (result.bytesRead !== bytes.length) throw new Error('trace changed while reading the requested page')
      const records = selected.map((offset) => {
        const line = bytes.subarray(offset.start - start, offset.end - start).toString('utf8')
        return JSON.parse(line) as Readonly<Record<string, unknown>>
      })
      const next = cursor + selected.length
      return {
        records,
        cursor,
        ...(next < file.offsets.length ? { nextCursor: next } : {}),
        total: file.offsets.length,
      }
    } finally {
      await handle.close()
    }
  }

  private async append(index: FileIndex, handle: FileHandle, newSize: number): Promise<void> {
    const appended = Buffer.alloc(newSize - index.readOffset)
    const result = await handle.read(appended, 0, appended.length, index.readOffset)
    if (result.bytesRead !== appended.length) throw new Error('trace changed during indexing')
    const combined = Buffer.concat([index.pending, appended])
    let lineStart = 0
    for (let newline = combined.indexOf(0x0a); newline !== -1; newline = combined.indexOf(0x0a, lineStart)) {
      let lineEnd = newline
      if (lineEnd > lineStart && combined[lineEnd - 1] === 0x0d) lineEnd -= 1
      this.indexLine(index, combined.subarray(lineStart, lineEnd), index.pendingStart + lineStart, index.pendingStart + lineEnd)
      lineStart = newline + 1
    }
    index.pending = combined.subarray(lineStart)
    index.pendingStart += lineStart
    index.readOffset = newSize
    index.size = newSize
  }

  private indexLine(index: FileIndex, bytes: Buffer, start: number, end: number): void {
    const line = index.nextLine++
    if (bytes.length === 0) return
    let value: unknown
    try {
      value = JSON.parse(bytes.toString('utf8')) as unknown
    } catch (error: unknown) {
      index.diagnostics.push({
        code: 'malformed-line', line, byteOffset: start,
        message: `Line ${line} is not valid JSON: ${errorMessage(error)}`,
      })
      index.summary = { ...index.summary, diagnosticCount: index.diagnostics.length }
      return
    }
    if (!isObject(value)) {
      index.diagnostics.push({ code: 'invalid-record', line, byteOffset: start, message: `Line ${line} is not a JSON object` })
      index.summary = { ...index.summary, diagnosticCount: index.diagnostics.length }
      return
    }

    index.offsets.push({ start, end, line })
    if (value.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
      index.diagnostics.push({
        code: 'unsupported-schema', line, byteOffset: start,
        message: `Line ${line} uses unsupported schema version ${String(value.schemaVersion)}`,
      })
      index.summary = {
        ...index.summary,
        recordCount: index.offsets.length,
        diagnosticCount: index.diagnostics.length,
        incompatible: true,
      }
      return
    }
    if (typeof value.type !== 'string' || typeof value.time !== 'number'
      || !Number.isFinite(value.time) || typeof value.sessionId !== 'string'
      || typeof value.sourceSeq !== 'number' || !Number.isSafeInteger(value.sourceSeq)) {
      index.diagnostics.push({ code: 'invalid-record', line, byteOffset: start, message: `Line ${line} has an invalid schema 1 envelope` })
      index.summary = { ...index.summary, recordCount: index.offsets.length, diagnosticCount: index.diagnostics.length }
      return
    }
    this.summarize(index, value)
  }

  private summarize(index: FileIndex, record: Record<string, unknown>): void {
    const summary = index.summary
    const time = record.time as number
    let runCount = summary.runCount
    let failureCount = summary.failureCount
    let modelTimeMs = summary.modelTimeMs
    let toolTimeMs = summary.toolTimeMs
    let totalTokens = summary.totalTokens
    let gapCount = summary.gapCount
    if (record.type === 'run.start') {
      runCount += 1
      const runId = stringValue(record.runId)
      if (runId !== undefined) index.runs.set(runId, { runId, startedAt: time })
    } else if (record.type === 'run.end') {
      const outcome = stringValue(record.outcome)
      if (outcome === 'error') failureCount += 1
      const runId = stringValue(record.runId)
      if (runId !== undefined) {
        const run = index.runs.get(runId) ?? { runId }
        run.endedAt = time
        run.outcome = outcome
        run.durationMs = durationValue(record.durationMs)
        index.runs.set(runId, run)
      }
    } else if (record.type === 'llm.end') {
      modelTimeMs += durationValue(record.durationMs) ?? 0
      totalTokens += tokenCount(record.usage)
    } else if (record.type === 'tool.end') {
      toolTimeMs += durationValue(record.durationMs) ?? 0
      if (record.outcome === 'error') failureCount += 1
    } else if (record.type === 'trace.gap') {
      gapCount += 1
    }
    index.summary = {
      ...summary,
      sessionId: stringValue(record.sessionId) ?? summary.sessionId,
      ...(record.type === 'session.meta' && typeof record.parentSessionId === 'string'
        ? { parentSessionId: record.parentSessionId }
        : {}),
      ...(record.type === 'session.meta' && typeof record.createdAt === 'number'
        ? { createdAt: record.createdAt }
        : {}),
      firstTime: summary.firstTime === undefined ? time : Math.min(summary.firstTime, time),
      lastTime: summary.lastTime === undefined ? time : Math.max(summary.lastTime, time),
      recordCount: index.offsets.length,
      runCount,
      failureCount,
      modelTimeMs,
      toolTimeMs,
      totalTokens,
      gapCount,
      truncatedValueCount: summary.truncatedValueCount + countTruncated(record),
      diagnosticCount: index.diagnostics.length,
    }
  }

  private fileBySessionId(sessionId: string): FileIndex | undefined {
    return [...this.files.values()].find((file) => file.summary.sessionId === sessionId)
  }

  private removeAll(diagnostics: readonly TraceDiagnostic[]): TraceChangeSet {
    const removed = [...this.files.keys()]
    this.files.clear()
    return { changed: [], reset: [], removed, diagnostics }
  }
}

function emptyIndex(key: string, path: string, identity: string): FileIndex {
  return {
    key, path, identity, size: 0, readOffset: 0, pending: Buffer.alloc(0), pendingStart: 0,
    nextLine: 1, offsets: [], diagnostics: [], runs: new Map(),
    summary: {
      key, recordCount: 0, runCount: 0, failureCount: 0, modelTimeMs: 0, toolTimeMs: 0,
      totalTokens: 0, gapCount: 0, truncatedValueCount: 0, diagnosticCount: 0, incompatible: false,
    },
  }
}

function fileIdentity(metadata: Stats): string {
  return `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`
}

async function openValidatedRegularFile(
  path: string,
  expectedIdentity?: string,
): Promise<{ readonly handle: FileHandle; readonly metadata: Stats }> {
  const before = await lstat(path)
  if (!before.isFile()) throw new Error('trace path is not a regular file')
  const handle = await open(path, 'r')
  try {
    const metadata = await handle.stat()
    const after = await lstat(path)
    const identity = fileIdentity(metadata)
    if (!metadata.isFile() || !after.isFile()
      || fileIdentity(before) !== identity || fileIdentity(after) !== identity) {
      throw new Error('trace path changed while opening it')
    }
    if (expectedIdentity !== undefined && identity !== expectedIdentity) {
      throw new Error('trace file was replaced after indexing')
    }
    return { handle, metadata }
  } catch (error: unknown) {
    await handle.close()
    throw error
  }
}

function addDiagnostic(index: FileIndex, diagnostic: TraceDiagnostic): void {
  const duplicate = index.diagnostics.some((item) => item.code === diagnostic.code
    && item.message === diagnostic.message && item.line === diagnostic.line
    && item.byteOffset === diagnostic.byteOffset)
  if (duplicate) return
  index.diagnostics = [...index.diagnostics, diagnostic]
  index.summary = { ...index.summary, diagnosticCount: index.diagnostics.length }
}

function validKey(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function durationValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function tokenCount(value: unknown): number {
  if (!isObject(value)) return 0
  const total = value.totalTokens ?? value.total_tokens
  if (typeof total === 'number' && Number.isFinite(total) && total >= 0) return total
  return ['inputTokens', 'outputTokens', 'input_tokens', 'output_tokens']
    .reduce((sum, key) => sum + (typeof value[key] === 'number' && Number.isFinite(value[key]) ? Math.max(0, value[key]) : 0), 0)
}

function countTruncated(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countTruncated(item), 0)
  if (!isObject(value)) return 0
  return (value.truncated === true ? 1 : 0)
    + Object.values(value).reduce<number>((sum, item) => sum + countTruncated(item), 0)
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  return value
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return value
}

function isMissing(error: unknown): boolean {
  return isObject(error) && error.code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}
