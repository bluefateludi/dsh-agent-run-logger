import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { captureContent } from './content.js'
import type { CapturedContent, ResolvedConfig, TraceRecord } from './types.js'
import type { SessionWriter } from './writer.js'

interface StepState {
  readonly turn: number
  readonly step: number
  readonly startedAt: number
  readonly inputs: CapturedContent[]
  firstTokenSeen: boolean
  llmEnded: boolean
}

interface ToolState {
  readonly turn: number
  readonly step: number
  readonly name: string
  readonly startedAt: number
}

/** Project canonical Session events into a compact run-oriented trace. */
export class RunTraceProjector {
  private readonly runStarts = new Map<number, number>()
  private readonly steps = new Map<string, StepState>()
  private readonly tools = new Map<string, ToolState>()
  private metadataWritten = false

  constructor(
    private readonly session: Session,
    private readonly writer: SessionWriter,
    private readonly config: ResolvedConfig,
  ) {}

  /** Consume one newly committed Session event. */
  accept(event: SessionEvent): void {
    if (!isRelevantEvent(event.type)) return
    this.writeMetadata(event)
    switch (event.type) {
      case 'turn/start':
        this.runStarts.set(event.data.turn, event.time)
        this.write(event, 'run.start', { runId: this.runId(event.data.turn), turn: event.data.turn })
        break
      case 'turn/end': {
        const startedAt = this.runStarts.get(event.data.turn)
        const reason = event.data.reason
        this.write(event, 'run.end', {
          runId: this.runId(event.data.turn),
          turn: event.data.turn,
          outcome: reason.kind,
          durationMs: duration(startedAt, event.time),
          ...(reason.kind === 'error' ? { errorCode: reason.error.code } : {}),
        }, true)
        this.runStarts.delete(event.data.turn)
        break
      }
      case 'step/start': {
        const state: StepState = {
          turn: event.data.turn,
          step: event.data.step,
          startedAt: event.time,
          inputs: [],
          firstTokenSeen: false,
          llmEnded: false,
        }
        this.steps.set(stepKey(event.data.turn, event.data.step), state)
        this.write(event, 'step.start', this.stepFields(state))
        break
      }
      case 'step/end': {
        const state = this.steps.get(stepKey(event.data.turn, event.data.step))
        if (state !== undefined && !state.llmEnded) {
          this.write(event, 'llm.end', {
            ...this.stepFields(state),
            outcome: 'incomplete',
            durationMs: duration(state.startedAt, event.time),
          })
        }
        this.write(event, 'step.end', {
          runId: this.runId(event.data.turn),
          stepId: this.stepId(event.data.turn, event.data.step),
          turn: event.data.turn,
          step: event.data.step,
          durationMs: duration(state?.startedAt, event.time),
        })
        this.steps.delete(stepKey(event.data.turn, event.data.step))
        break
      }
      case 'user/message': {
        if (!this.config.includeContent) break
        const state = newestOpenStep(this.steps)
        if (state !== undefined) state.inputs.push(this.capture(event.data))
        break
      }
      case 'assistant/chunk': {
        const state = this.steps.get(stepKey(event.data.turn, event.data.step))
        if (state === undefined || state.firstTokenSeen || !hasToken(event.data.chunk)) break
        state.firstTokenSeen = true
        this.write(event, 'llm.first_token', {
          ...this.stepFields(state),
          durationMs: duration(state.startedAt, event.time),
        })
        break
      }
      case 'assistant/message': {
        const state = this.steps.get(stepKey(event.data.turn, event.data.step))
        const source = event.data.message.source
        if (state !== undefined) state.llmEnded = true
        this.write(event, 'llm.end', {
          runId: this.runId(event.data.turn),
          stepId: this.stepId(event.data.turn, event.data.step),
          turn: event.data.turn,
          step: event.data.step,
          outcome: 'completed',
          durationMs: duration(state?.startedAt, event.time),
          provider: source.provider,
          model: source.model,
          ...(event.data.usage === undefined ? {} : { usage: event.data.usage }),
          ...(this.config.includeContent ? {
            input: state?.inputs ?? [],
            output: this.capture(event.data.message),
          } : {}),
        })
        break
      }
      case 'tool/call': {
        this.tools.set(event.data.callId, {
          turn: event.data.turn,
          step: event.data.step,
          name: event.data.name,
          startedAt: event.time,
        })
        this.write(event, 'tool.start', {
          runId: this.runId(event.data.turn),
          stepId: this.stepId(event.data.turn, event.data.step),
          toolId: event.data.callId,
          turn: event.data.turn,
          step: event.data.step,
          name: event.data.name,
          ...(this.config.includeContent
            ? { arguments: this.capture(event.data.arguments) }
            : {}),
        })
        break
      }
      case 'tool/result': {
        const callId = event.data.message.source.callId
        const state = this.tools.get(callId)
        const block = event.data.message.content[0]
        const isError = block?.type === 'tool-result' ? block.isError === true : event.data.error !== undefined
        this.write(event, 'tool.end', {
          runId: this.runId(event.data.turn),
          stepId: this.stepId(event.data.turn, event.data.step),
          toolId: callId,
          turn: event.data.turn,
          step: event.data.step,
          name: state?.name,
          outcome: isError ? 'error' : 'completed',
          durationMs: duration(state?.startedAt, event.time),
          ...(event.data.error === undefined ? {} : {
            errorName: event.data.error.name,
            errorCode: event.data.error.code,
          }),
          ...(this.config.includeContent
            ? { result: this.capture(event.data.message) }
            : {}),
        })
        this.tools.delete(callId)
        break
      }
      default:
        // SessionEventMap is merge-extensible; unrelated plugin events are intentionally ignored.
        break
    }
  }

  /** Write session identity and lineage once, immediately before the first projected event. */
  private writeMetadata(event: SessionEvent): void {
    if (this.metadataWritten) return
    this.metadataWritten = true
    const header = this.session.header
    this.write(event, 'session.meta', {
      createdAt: header.createdAt,
      cwd: header.cwd,
      parentSessionId: header.parentSession,
      origin: header.origin,
      delegationDepth: header.delegationDepth,
      agentPreset: header.agentPreset,
    })
  }

  /** Add the common record envelope and enqueue it. */
  private write(
    event: SessionEvent,
    type: string,
    fields: Record<string, unknown>,
    syncAfter = false,
  ): void {
    const record: TraceRecord = {
      schemaVersion: 1,
      type,
      time: event.time,
      sessionId: this.session.id,
      sourceSeq: event.seq,
      ...withoutUndefined(fields),
    }
    this.writer.enqueue(record, syncAfter)
  }

  /** Stable run identifier local to this trace schema. */
  private runId(turn: number): string {
    return `${this.session.id}:turn:${turn}`
  }

  /** Stable step identifier local to this trace schema. */
  private stepId(turn: number, step: number): string {
    return `${this.runId(turn)}:step:${step}`
  }

  /** Common fields for records owned by one known step. */
  private stepFields(state: StepState): Record<string, unknown> {
    return {
      runId: this.runId(state.turn),
      stepId: this.stepId(state.turn, state.step),
      turn: state.turn,
      step: state.step,
    }
  }

  /** Redact sensitive values before applying the configured content byte limit. */
  private capture(value: unknown): CapturedContent {
    return captureContent(value, this.config.maxContentBytes, {
      enabled: this.config.redactSensitiveContent,
      keys: this.config.redactKeys,
    })
  }
}

/** Whether one canonical event contributes to this compact projection. */
function isRelevantEvent(type: string): boolean {
  return type === 'turn/start'
    || type === 'turn/end'
    || type === 'step/start'
    || type === 'step/end'
    || type === 'user/message'
    || type === 'assistant/chunk'
    || type === 'assistant/message'
    || type === 'tool/call'
    || type === 'tool/result'
}

/** Map a turn and step pair to one in-memory state key. */
function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

/** Clamp observed elapsed time while preserving unknown starts. */
function duration(startedAt: number | undefined, endedAt: number): number | undefined {
  return startedAt === undefined ? undefined : Math.max(0, endedAt - startedAt)
}

/** Whether a stream chunk carries model-produced token material. */
function hasToken(chunk: SessionEvent<'assistant/chunk'>['data']['chunk']): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text.length > 0
    case 'tool-call-delta':
      return chunk.name !== undefined || chunk.argumentsDelta.length > 0
    default:
      return false
  }
}

/** Find the most recently opened step for unscoped user-message events. */
function newestOpenStep(steps: Map<string, StepState>): StepState | undefined {
  let latest: StepState | undefined
  for (const state of steps.values()) {
    if (latest === undefined || state.startedAt >= latest.startedAt) latest = state
  }
  return latest
}

/** Omit undefined properties so JSON records communicate absence explicitly. */
function withoutUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== undefined))
}
