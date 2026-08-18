import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TraceRepository } from '../src/viewer/repository.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('TraceRepository', () => {
  it('keeps a partial UTF-8 line pending and indexes only after its newline arrives', async () => {
    const directory = await temporaryDirectory()
    const path = tracePath(directory, '会话/一')
    const bytes = Buffer.from(JSON.stringify(record('会话/一', 'custom.event', 1, { label: '你好' })), 'utf8')
    const split = bytes.indexOf(Buffer.from('好')) + 1
    await writeFile(path, bytes.subarray(0, split))
    const repository = new TraceRepository({ traceDirectory: directory, defaultPageSize: 10 })

    expect(await repository.refresh()).toMatchObject({ changed: [key('会话/一')], removed: [] })
    expect((await repository.refresh()).reset).toEqual([])
    expect(repository.list()[0]).toMatchObject({ recordCount: 0 })
    await appendFile(path, Buffer.concat([bytes.subarray(split), Buffer.from('\n')]))
    expect(await repository.refresh()).toMatchObject({ changed: [key('会话/一')] })

    expect(repository.list()[0]).toMatchObject({ sessionId: '会话/一', recordCount: 1 })
    expect(await repository.records(key('会话/一'), { cursor: 0, limit: 10 })).toMatchObject({
      records: [{ type: 'custom.event', label: '你好' }], cursor: 0, total: 1,
    })
    expect((await repository.refresh()).changed).toEqual([])
  })

  it('reports malformed and unsupported rows without hiding later records', async () => {
    const directory = await temporaryDirectory()
    const path = tracePath(directory, 'diagnostic')
    await writeFile(path, [
      '{broken',
      JSON.stringify({ ...record('diagnostic', 'future.event', 1), schemaVersion: 99, extra: { preserved: true } }),
      JSON.stringify(record('diagnostic', 'run.start', 2, { runId: 'run-1' })),
      JSON.stringify(record('diagnostic', 'run.end', 3, { runId: 'run-1', outcome: 'error', durationMs: 10 })),
      '',
    ].join('\n'))
    const repository = new TraceRepository({ traceDirectory: directory })

    await repository.refresh()
    const detail = repository.detail(key('diagnostic'))
    expect(detail?.summary).toMatchObject({
      recordCount: 3, runCount: 1, failureCount: 1, diagnosticCount: 2, incompatible: true,
    })
    expect(detail?.diagnostics.map((item) => item.code)).toEqual(['malformed-line', 'unsupported-schema'])
    expect((await repository.records(key('diagnostic'), { limit: 10 })).records).toEqual([
      expect.objectContaining({ schemaVersion: 99, extra: { preserved: true } }),
      expect.objectContaining({ type: 'run.start' }),
      expect.objectContaining({ type: 'run.end' }),
    ])
  })

  it('derives summaries, bounded paging, and navigable parent-child lineage', async () => {
    const directory = await temporaryDirectory()
    await writeTrace(directory, 'parent', [
      record('parent', 'session.meta', 10, { createdAt: 5 }),
      record('parent', 'run.start', 11, { runId: 'p:1' }),
      record('parent', 'llm.end', 14, { durationMs: 3, usage: { inputTokens: 2, outputTokens: 4 } }),
      record('parent', 'tool.end', 18, { durationMs: 4, outcome: 'error' }),
      record('parent', 'trace.gap', 19),
      record('parent', 'run.end', 20, { runId: 'p:1', outcome: 'completed', durationMs: 9, value: { truncated: true } }),
    ])
    await writeTrace(directory, 'child', [
      record('child', 'session.meta', 21, { parentSessionId: 'parent' }),
      record('child', 'run.start', 22, { runId: 'c:1' }),
    ])
    await writeTrace(directory, 'orphan', [record('orphan', 'session.meta', 23, { parentSessionId: 'external' })])
    const repository = new TraceRepository({ traceDirectory: directory, defaultPageSize: 2, maximumPageSize: 3 })

    await repository.refresh()
    expect(repository.detail(key('parent'))?.summary).toMatchObject({
      runCount: 1, failureCount: 1, modelTimeMs: 3, toolTimeMs: 4, totalTokens: 6,
      gapCount: 1, truncatedValueCount: 1,
    })
    expect(repository.detail(key('parent'))?.lineage.children).toEqual([{ key: key('child'), sessionId: 'child' }])
    expect(repository.detail(key('child'))?.lineage.parent).toEqual({ key: key('parent'), sessionId: 'parent' })
    expect(repository.detail(key('orphan'))?.lineage.parent).toEqual({ sessionId: 'external' })
    const first = await repository.records(key('parent'), { cursor: 0, limit: 100 })
    expect(first).toMatchObject({ cursor: 0, nextCursor: 3, total: 6 })
    expect(first.records).toHaveLength(3)
    expect(repository.detail('../parent')).toBeUndefined()
    expect(await repository.records('../parent', {})).toEqual({ records: [], cursor: 0, total: 0 })
  })

  it('re-indexes a truncated file and removes traces that disappear', async () => {
    const directory = await temporaryDirectory()
    const path = await writeTrace(directory, 'replace', [
      record('replace', 'run.start', 1, { runId: 'old' }),
      record('replace', 'run.end', 2, { runId: 'old', outcome: 'error' }),
    ])
    const repository = new TraceRepository({ traceDirectory: directory })
    await repository.refresh()
    expect(repository.list()[0]).toMatchObject({ recordCount: 2, failureCount: 1 })

    await writeFile(path, `${JSON.stringify(record('replace', 'custom', 3))}\n`)
    expect(await repository.refresh()).toMatchObject({ changed: [key('replace')], reset: [key('replace')] })
    expect(repository.list()[0]).toMatchObject({ recordCount: 1, failureCount: 0 })
    await writeFile(path, '')
    expect(await repository.refresh()).toMatchObject({ changed: [key('replace')], reset: [key('replace')] })
    expect(repository.list()[0]).toMatchObject({ recordCount: 0, failureCount: 0 })
    await rm(path)
    expect((await repository.refresh()).removed).toEqual([key('replace')])
    expect(repository.list()).toEqual([])
  })

  it('treats a missing directory as an empty live repository', async () => {
    const directory = join(tmpdir(), `dsh-viewer-missing-${crypto.randomUUID()}`)
    const repository = new TraceRepository({ traceDirectory: directory })
    expect(await repository.refresh()).toEqual({ changed: [], reset: [], removed: [], diagnostics: [] })
    expect(repository.list()).toEqual([])
  })

  it('reports replacements separately from ordinary appends', async () => {
    const directory = await temporaryDirectory()
    const path = await writeTrace(directory, 'identity', [record('identity', 'custom', 1)])
    const repository = new TraceRepository({ traceDirectory: directory })
    expect(await repository.refresh()).toMatchObject({ changed: [key('identity')], reset: [] })

    await appendFile(path, `${JSON.stringify(record('identity', 'custom', 2))}\n`)
    expect(await repository.refresh()).toMatchObject({ changed: [key('identity')], reset: [] })

    const oldPath = `${path}.old`
    await rename(path, oldPath)
    await writeTrace(directory, 'identity', [
      record('identity', 'custom', 3),
      record('identity', 'custom', 4),
      record('identity', 'custom', 5),
    ])
    expect(await repository.refresh()).toMatchObject({
      changed: [key('identity')], reset: [key('identity')],
    })
    expect(repository.list()[0]).toMatchObject({ recordCount: 3 })
  })

  it('rejects symbolic-link candidates', async () => {
    const directory = await temporaryDirectory()
    const target = join(directory, 'target.txt')
    await writeFile(target, `${JSON.stringify(record('linked', 'custom', 1))}\n`)
    const linkedPath = tracePath(directory, 'linked')
    try {
      await symlink(target, linkedPath, 'file')
    } catch (error: unknown) {
      if (!isWindowsSymlinkPrivilegeError(error)) throw error
    }
    const targetDirectory = join(directory, 'target-directory')
    await mkdir(targetDirectory)
    await mkdir(tracePath(directory, 'directory'))
    try {
      await symlink(targetDirectory, tracePath(directory, 'junction'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error: unknown) {
      if (!isWindowsSymlinkPrivilegeError(error)) throw error
    }
    const repository = new TraceRepository({ traceDirectory: directory })
    expect(await repository.refresh()).toMatchObject({ changed: [], reset: [] })
    expect(repository.list()).toEqual([])
  })

  it('rejects files replaced before a page read', async () => {
    const directory = await temporaryDirectory()
    const repository = new TraceRepository({ traceDirectory: directory })
    const path = await writeTrace(directory, 'replace-before-read', [record('replace-before-read', 'custom', 1)])
    await repository.refresh()
    await rename(path, `${path}.old`)
    await writeTrace(directory, 'replace-before-read', [record('replace-before-read', 'custom', 2)])
    await expect(repository.records(key('replace-before-read'), {})).rejects.toThrow('replaced after indexing')
  })

  it('does not duplicate persistent diagnostics during unchanged refreshes', async () => {
    const directory = await temporaryDirectory()
    await writeFile(tracePath(directory, 'bad'), '{broken\n')
    const repository = new TraceRepository({ traceDirectory: directory })
    await repository.refresh()
    expect(repository.detail(key('bad'))?.diagnostics).toHaveLength(1)
    await repository.refresh()
    await repository.refresh()
    expect(repository.detail(key('bad'))?.diagnostics).toHaveLength(1)
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-viewer-repository-'))
  temporaryDirectories.push(directory)
  return directory
}

function key(sessionId: string): string {
  return Buffer.from(sessionId, 'utf8').toString('base64url')
}

function tracePath(directory: string, sessionId: string): string {
  return join(directory, `${key(sessionId)}.jsonl`)
}

async function writeTrace(directory: string, sessionId: string, records: readonly Record<string, unknown>[]): Promise<string> {
  const path = tracePath(directory, sessionId)
  await writeFile(path, `${records.map((item) => JSON.stringify(item)).join('\n')}\n`)
  return path
}

function record(sessionId: string, type: string, sourceSeq: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, type, time: 1_000 + sourceSeq, sessionId, sourceSeq, ...fields }
}

function isWindowsSymlinkPrivilegeError(error: unknown): boolean {
  return process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM'
}
