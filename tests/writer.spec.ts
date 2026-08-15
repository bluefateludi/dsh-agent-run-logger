import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TraceRecord } from '../src/types.js'
import { SessionWriter } from '../src/writer.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function temporaryPath(filename: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-run-logger-'))
  temporaryDirectories.push(directory)
  return join(directory, filename)
}

function record(seq: number, payload = ''): TraceRecord {
  return { schemaVersion: 1, type: 'test', time: 1_000 + seq, sessionId: 's', sourceSeq: seq, payload }
}

describe('SessionWriter', () => {
  it('preserves record order and drains on dispose', async () => {
    const path = await temporaryPath('nested/trace.jsonl')
    const warnings: string[] = []
    const writer = new SessionWriter({ path, sessionId: 's', maxPendingBytes: 4096, warn: (value) => warnings.push(value) })
    writer.enqueue(record(1))
    writer.enqueue(record(2), true)
    writer.enqueue(record(3))
    await writer.dispose()

    const lines = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as TraceRecord)
    expect(lines.map((line) => line.sourceSeq)).toEqual([1, 2, 3])
    expect(warnings).toEqual([])
  })

  it('reports queue overflow as a final gap without blocking disposal', async () => {
    const path = await temporaryPath('trace.jsonl')
    const writer = new SessionWriter({ path, sessionId: 's', maxPendingBytes: 64, warn: () => undefined })
    writer.enqueue(record(10, 'x'.repeat(100)))
    writer.enqueue(record(11, 'x'.repeat(100)))
    await writer.dispose()

    const gap = JSON.parse((await readFile(path, 'utf8')).trim()) as Record<string, unknown>
    expect(gap).toMatchObject({
      type: 'trace.gap',
      droppedRecords: 2,
      firstDroppedSeq: 10,
      lastDroppedSeq: 11,
    })
  })

  it('isolates filesystem failure and warns only once', async () => {
    const parent = await temporaryPath('not-a-directory')
    await writeFile(parent, 'file')
    const warnings: string[] = []
    const writer = new SessionWriter({
      path: join(parent, 'trace.jsonl'),
      sessionId: 'failed-session',
      maxPendingBytes: 4096,
      warn: (value) => warnings.push(value),
    })
    writer.enqueue(record(1))
    writer.enqueue(record(2))
    await expect(writer.dispose()).resolves.toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('failed-session')
  })

  it('drains two session writers independently', async () => {
    const firstPath = await temporaryPath('first.jsonl')
    const secondPath = await temporaryPath('second.jsonl')
    const first = new SessionWriter({ path: firstPath, sessionId: 'first', maxPendingBytes: 4096, warn: () => undefined })
    const second = new SessionWriter({ path: secondPath, sessionId: 'second', maxPendingBytes: 4096, warn: () => undefined })
    first.enqueue({ ...record(1), sessionId: 'first' })
    second.enqueue({ ...record(1), sessionId: 'second' })
    await Promise.all([first.dispose(), second.dispose()])
    expect(await readFile(firstPath, 'utf8')).toContain('"sessionId":"first"')
    expect(await readFile(secondPath, 'utf8')).toContain('"sessionId":"second"')
  })
})
