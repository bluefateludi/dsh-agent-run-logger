import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { RunTraceProjector } from '../src/projector.js'
import type { ResolvedConfig } from '../src/types.js'
import { SessionWriter } from '../src/writer.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function event(type: string, seq: number, time: number, data: unknown): SessionEvent {
  return { type, seq, time, data } as SessionEvent
}

describe('RunTraceProjector', () => {
  it('projects a multi-step run with model and tool timings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-run-projector-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'trace.jsonl')
    const session = {
      id: 'session/one',
      header: { version: 0, id: 'session/one', createdAt: 900, cwd: directory, parentSession: 'parent' },
    } as unknown as Session
    const config: ResolvedConfig = {
      outputDir: '.dsh/traces',
      includeContent: true,
      maxContentBytes: 128,
      maxPendingBytes: 16_384,
    }
    const writer = new SessionWriter({ path, sessionId: session.id, maxPendingBytes: config.maxPendingBytes, warn: () => undefined })
    const projector = new RunTraceProjector(session, writer, config)

    projector.accept(event('turn/start', 0, 1_000, { turn: 1 }))
    projector.accept(event('step/start', 1, 1_010, { turn: 1, step: 1 }))
    projector.accept(event('user/message', 2, 1_020, { id: 'u1', role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: 'hello' }] }))
    projector.accept(event('assistant/chunk', 3, 1_050, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } }))
    projector.accept(event('assistant/message', 4, 1_100, {
      turn: 1,
      step: 1,
      message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'test', model: 'm' }, content: [{ type: 'text', text: 'hi' }] },
      usage: { inputTokens: 5, outputTokens: 2 },
    }))
    projector.accept(event('tool/call', 5, 1_110, { turn: 1, step: 1, callId: 'call-1', name: 'demo', arguments: '{"x":1}' }))
    projector.accept(event('tool/result', 6, 1_150, {
      turn: 1,
      step: 1,
      message: {
        id: 'r1',
        role: 'user',
        source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'ok' }] }],
      },
    }))
    projector.accept(event('step/end', 7, 1_160, { turn: 1, step: 1 }))
    projector.accept(event('step/start', 8, 1_170, { turn: 1, step: 2 }))
    projector.accept(event('step/end', 9, 1_190, { turn: 1, step: 2 }))
    projector.accept(event('turn/end', 10, 1_200, { turn: 1, reason: { kind: 'completed' } }))
    await writer.dispose()

    const records = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records.map((record) => record.type)).toEqual([
      'session.meta', 'run.start', 'step.start', 'llm.first_token', 'llm.end',
      'tool.start', 'tool.end', 'step.end', 'step.start', 'llm.end', 'step.end', 'run.end',
    ])
    expect(records[0]).toMatchObject({ sessionId: 'session/one', parentSessionId: 'parent' })
    expect(records.find((record) => record.type === 'llm.first_token')).toMatchObject({ durationMs: 40 })
    expect(records.find((record) => record.type === 'tool.end')).toMatchObject({ durationMs: 40, outcome: 'completed' })
    expect(records.at(-1)).toMatchObject({ durationMs: 200, outcome: 'completed' })
  })

  it('does not capture content unless explicitly enabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-run-projector-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'trace.jsonl')
    const session = { id: 's', header: { version: 0, id: 's', createdAt: 1, cwd: directory } } as unknown as Session
    const writer = new SessionWriter({ path, sessionId: 's', maxPendingBytes: 4096, warn: () => undefined })
    const projector = new RunTraceProjector(session, writer, {
      outputDir: '.dsh/traces', includeContent: false, maxContentBytes: 64, maxPendingBytes: 4096,
    })
    projector.accept(event('tool/call', 1, 10, { turn: 1, step: 1, callId: 'c', name: 'secret', arguments: 'TOP_SECRET' }))
    await writer.dispose()
    expect(await readFile(path, 'utf8')).not.toContain('TOP_SECRET')
  })
})
