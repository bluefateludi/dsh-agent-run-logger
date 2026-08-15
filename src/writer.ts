import { mkdir, open, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TraceRecord } from './types.js'

interface PendingLine {
  readonly line: string
  readonly bytes: number
  readonly syncAfter: boolean
}

interface Gap {
  count: number
  firstSeq: number
  lastSeq: number
  time: number
}

/** Options for one independently drained session file. */
export interface SessionWriterOptions {
  path: string
  sessionId: string
  maxPendingBytes: number
  warn(message: string): void
}

/** Append-only, bounded, non-blocking JSONL writer for one session. */
export class SessionWriter {
  private readonly queue: PendingLine[] = []
  private pendingBytes = 0
  private handle: FileHandle | undefined
  private drainPromise: Promise<void> | undefined
  private gap: Gap | undefined
  private accepting = true
  private failed = false

  constructor(private readonly options: SessionWriterOptions) {}

  /** Queue one record without waiting for filesystem work. */
  enqueue(record: TraceRecord, syncAfter = false): void {
    if (!this.accepting || this.failed) return
    try {
      this.enqueueGap(record)
      const line = `${JSON.stringify(record)}\n`
      const bytes = Buffer.byteLength(line)
      if (bytes > this.options.maxPendingBytes - this.pendingBytes) {
        this.noteDrop(record.sourceSeq, record.time)
        return
      }
      this.queue.push({ line, bytes, syncAfter })
      this.pendingBytes += bytes
      this.startDrain()
    } catch (error: unknown) {
      this.fail(error)
    }
  }

  /** Stop accepting records, drain queued lines, sync, close, and reach quiescence. */
  async dispose(): Promise<void> {
    this.accepting = false
    await this.awaitDrain()
    await this.flushFinalGap()
    if (this.handle === undefined) return
    try {
      await this.handle.sync()
      await this.handle.close()
    } catch (error: unknown) {
      this.fail(error)
    } finally {
      this.handle = undefined
    }
  }

  /** Persist an overload marker even when no later source record arrived. */
  private async flushFinalGap(): Promise<void> {
    if (this.gap === undefined || this.failed) return
    const gap = this.gap
    this.gap = undefined
    const record: TraceRecord = {
      schemaVersion: 1,
      type: 'trace.gap',
      time: gap.time,
      sessionId: this.options.sessionId,
      sourceSeq: gap.lastSeq,
      droppedRecords: gap.count,
      firstDroppedSeq: gap.firstSeq,
      lastDroppedSeq: gap.lastSeq,
    }
    try {
      const handle = await this.open()
      await handle.appendFile(`${JSON.stringify(record)}\n`, 'utf8')
    } catch (error: unknown) {
      this.fail(error)
    }
  }

  /** Materialize accumulated loss before the next record when capacity permits. */
  private enqueueGap(next: TraceRecord): void {
    if (this.gap === undefined) return
    const record: TraceRecord = {
      schemaVersion: 1,
      type: 'trace.gap',
      time: next.time,
      sessionId: this.options.sessionId,
      sourceSeq: this.gap.lastSeq,
      droppedRecords: this.gap.count,
      firstDroppedSeq: this.gap.firstSeq,
      lastDroppedSeq: this.gap.lastSeq,
    }
    const line = `${JSON.stringify(record)}\n`
    const bytes = Buffer.byteLength(line)
    if (bytes > this.options.maxPendingBytes - this.pendingBytes) return
    this.queue.push({ line, bytes, syncAfter: false })
    this.pendingBytes += bytes
    this.gap = undefined
  }

  /** Accumulate a contiguous report of records rejected by the queue limit. */
  private noteDrop(seq: number, time: number): void {
    if (this.gap === undefined) {
      this.gap = { count: 1, firstSeq: seq, lastSeq: seq, time }
      return
    }
    this.gap.count += 1
    this.gap.lastSeq = seq
    this.gap.time = time
  }

  /** Start exactly one drain loop and keep its rejection observed. */
  private startDrain(): void {
    if (this.drainPromise !== undefined) return
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = undefined
      if (this.queue.length > 0 && !this.failed) this.startDrain()
    })
  }

  /** Await all drain generations, including a generation scheduled by finalization. */
  private async awaitDrain(): Promise<void> {
    while (this.drainPromise !== undefined) await this.drainPromise
  }

  /** Write queued lines in order and sync at requested run boundaries. */
  private async drain(): Promise<void> {
    try {
      const handle = await this.open()
      while (this.queue.length > 0) {
        const item = this.queue.shift()
        if (item === undefined) return
        await handle.appendFile(item.line, 'utf8')
        this.pendingBytes -= item.bytes
        if (item.syncAfter) await handle.sync()
      }
    } catch (error: unknown) {
      this.fail(error)
    }
  }

  /** Lazily create the parent directory and open the append-only trace file. */
  private async open(): Promise<FileHandle> {
    if (this.handle !== undefined) return this.handle
    await mkdir(dirname(this.options.path), { recursive: true })
    this.handle = await open(this.options.path, 'a', 0o600)
    return this.handle
  }

  /** Permanently stop this session writer after its first internal failure. */
  private fail(error: unknown): void {
    if (this.failed) return
    this.failed = true
    this.accepting = false
    this.queue.length = 0
    this.pendingBytes = 0
    this.options.warn(`agent-run-logger stopped session ${JSON.stringify(this.options.sessionId)}: ${String(error)}`)
  }
}
