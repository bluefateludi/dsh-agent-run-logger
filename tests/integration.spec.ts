import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import apply from '../src/index.js'

const temporaryDirectories: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('plugin composition', () => {
  it('observes only live events and reopens the same trace after plugin reload', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'dsh-agent-run-integration-'))
    temporaryDirectories.push(outputDir)
    const context = new Context()
    contexts.push(context)
    await context.plugin(SessionStore)
    const session = context.sessions.create('reload-session')
    session.append('turn/start', { turn: 1 })

    const loggerFiber = context.plugin(apply, { outputDir })
    await loggerFiber
    session.append('turn/start', { turn: 2 })
    session.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    await loggerFiber.dispose()

    const reloadedFiber = context.plugin(apply, { outputDir })
    await reloadedFiber
    session.append('turn/start', { turn: 3 })
    session.append('turn/end', { turn: 3, reason: { kind: 'error', error: { message: 'failed', code: 'TEST_FAILURE' } } })
    await reloadedFiber.dispose()

    const filename = `${Buffer.from(session.id, 'utf8').toString('base64url')}.jsonl`
    const records = (await readFile(join(outputDir, filename), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records.map((record) => record.type)).toEqual([
      'session.meta', 'run.start', 'run.end',
      'session.meta', 'run.start', 'run.end',
    ])
    expect(records.map((record) => record.sourceSeq)).toEqual([1, 1, 2, 3, 3, 4])
    expect(records[2]).toMatchObject({ outcome: 'aborted' })
    expect(records.at(-1)).toMatchObject({ outcome: 'error', errorCode: 'TEST_FAILURE' })
  })
})
