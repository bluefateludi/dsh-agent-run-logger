/**
 * Local, bounded JSONL traces projected from newly committed DeepSeek Harness Session events.
 *
 * @module dsh-agent-run-logger
 */

import { isAbsolute, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { RunTraceProjector } from './projector.js'
import type { Config as ConfigShape, ResolvedConfig } from './types.js'
import { SessionWriter } from './writer.js'

/** Public plugin configuration. */
export type Config = ConfigShape

/** Cordis plugin name. */
export const name = 'agent-run-logger'

/** Services required before this plugin can activate. */
export const inject = ['sessions']

/** Default relative trace directory under each session working directory. */
export const DEFAULT_OUTPUT_DIR = '.dsh/traces'
/** Default maximum captured bytes for each content field. */
export const DEFAULT_MAX_CONTENT_BYTES = 64 * 1024
/** Default maximum queued bytes for each session writer. */
export const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024

/** Runtime configuration validator. */
export const Config: z<ConfigShape> = z.object({
  outputDir: z.string().min(1).default(DEFAULT_OUTPUT_DIR),
  includeContent: z.boolean().default(false),
  maxContentBytes: z.number().min(1).step(1).default(DEFAULT_MAX_CONTENT_BYTES),
  maxPendingBytes: z.number().min(1).step(1).default(DEFAULT_MAX_PENDING_BYTES),
})

/** Mount the run-trace projection and independent per-session writers. */
export function apply(ctx: Context, config: ConfigShape = {}): void {
  const resolved = resolveConfig(config)
  const projectors = new Map<Session, RunTraceProjector>()
  const writers = new Map<Session, SessionWriter>()
  const retiring = new Set<Promise<void>>()

  const stateFor = (session: Session): RunTraceProjector => {
    const existing = projectors.get(session)
    if (existing !== undefined) return existing
    const root = isAbsolute(resolved.outputDir)
      ? resolved.outputDir
      : resolve(session.header.cwd ?? process.cwd(), resolved.outputDir)
    const filename = `${Buffer.from(session.id, 'utf8').toString('base64url')}.jsonl`
    const writer = new SessionWriter({
      path: resolve(root, filename),
      sessionId: session.id,
      maxPendingBytes: resolved.maxPendingBytes,
      warn: (message) => ctx.logger.warn(message),
    })
    const projector = new RunTraceProjector(session, writer, resolved)
    writers.set(session, writer)
    projectors.set(session, projector)
    return projector
  }

  const disposeSession = (session: Session): void => {
    const writer = writers.get(session)
    projectors.delete(session)
    writers.delete(session)
    if (writer === undefined) return
    const promise = writer.dispose().catch((error: unknown) => {
      ctx.logger.warn(`agent-run-logger failed to dispose session ${JSON.stringify(session.id)}: ${String(error)}`)
    }).finally(() => retiring.delete(promise))
    retiring.add(promise)
  }

  const offEvent = ctx.on('session/event', (session, event) => {
    try {
      stateFor(session).accept(event)
    } catch (error: unknown) {
      ctx.logger.warn(`agent-run-logger ignored session ${JSON.stringify(session.id)} event ${event.seq}: ${String(error)}`)
    }
  })
  const offDisposed = ctx.on('session/disposed', disposeSession)

  ctx.effect(() => async () => {
    offEvent()
    offDisposed()
    const active = [...writers.values()].map((writer) => writer.dispose())
    projectors.clear()
    writers.clear()
    await Promise.allSettled([...active, ...retiring])
  }, 'agent-run-logger: stop listeners and drain session writers')
}

/** Apply direct-construction defaults and reject invalid integer limits. */
function resolveConfig(config: ConfigShape): ResolvedConfig {
  const resolved: ResolvedConfig = {
    outputDir: config.outputDir ?? DEFAULT_OUTPUT_DIR,
    includeContent: config.includeContent ?? false,
    maxContentBytes: config.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES,
    maxPendingBytes: config.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES,
  }
  if (resolved.outputDir.length === 0) throw new Error('agent-run-logger: outputDir must not be empty')
  assertPositiveInteger('maxContentBytes', resolved.maxContentBytes)
  assertPositiveInteger('maxPendingBytes', resolved.maxPendingBytes)
  return resolved
}

/** Reject direct callers that bypass the Cordis config schema. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`agent-run-logger: ${name} must be a positive safe integer, got ${String(value)}`)
  }
}

export default apply
