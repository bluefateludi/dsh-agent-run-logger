/** Configuration for the local Agent Run Logger. */
export interface Config {
  /** Absolute path, or a path relative to each session working directory. */
  outputDir?: string
  /** Whether prompt, reply, tool-argument, and tool-result content is captured. */
  includeContent?: boolean
  /** Maximum UTF-8 bytes retained for each captured content value. */
  maxContentBytes?: number
  /** Maximum queued JSONL bytes for each session writer. */
  maxPendingBytes?: number
}

/** Fully resolved plugin configuration. */
export interface ResolvedConfig {
  outputDir: string
  includeContent: boolean
  maxContentBytes: number
  maxPendingBytes: number
}

/** A content value retained in full or represented by a bounded preview. */
export type CapturedContent =
  | { content: unknown; truncated: false; originalBytes: number; capturedBytes: number }
  | {
    contentPreview: { head: string; tail: string }
    truncated: true
    originalBytes: number
    capturedBytes: number
  }

/** Shared envelope written for every JSONL trace record. */
export interface TraceRecord {
  schemaVersion: 1
  type: string
  time: number
  sessionId: string
  sourceSeq: number
  [key: string]: unknown
}
