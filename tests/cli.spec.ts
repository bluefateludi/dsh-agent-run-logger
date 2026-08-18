import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess, spawn } from 'node:child_process'
import {
  browserCommand,
  applyRetention,
  launchBrowser,
  MAX_PAGE_SIZE,
  MIN_POLL_MS,
  parseCliArguments,
} from '../src/cli.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('parseCliArguments', () => {
  it('resolves view defaults without side effects', () => {
    expect(parseCliArguments(['view'], 'C:\\project')).toEqual({
      kind: 'view',
      settings: {
        traceDir: resolve('C:\\project', '.dsh/traces'),
        port: 4318,
        pollMs: 750,
        pageSize: 500,
        openBrowser: true,
      },
    })
  })

  it('parses every supported view setting', () => {
    expect(parseCliArguments([
      'view', '--trace-dir', 'logs', '--port', '9000', '--poll-ms', '250',
      '--page-size', '40', '--no-open', '--retention-days', '1.5',
    ], '/work')).toEqual({
      kind: 'view',
      settings: {
        traceDir: resolve('/work', 'logs'),
        port: 9000,
        pollMs: 250,
        pageSize: 40,
        openBrowser: false,
        retentionDays: 1.5,
      },
    })
  })

  it.each([
    [['view', '--port', '-1'], '--port'],
    [['view', '--port', '1.5'], '--port'],
    [['view', '--poll-ms', String(MIN_POLL_MS - 1)], '--poll-ms'],
    [['view', '--page-size', String(MAX_PAGE_SIZE + 1)], '--page-size'],
    [['view', '--retention-days', '0'], '--retention-days'],
    [['view', '--trace-dir', ''], '--trace-dir'],
    [['unknown'], 'unknown command'],
  ])('rejects invalid input %j before execution', (argv, message) => {
    expect(() => parseCliArguments(argv)).toThrow(message)
  })

  it('recognizes help and version actions', () => {
    expect(parseCliArguments([])).toEqual({ kind: 'help' })
    expect(parseCliArguments(['--help'])).toEqual({ kind: 'help' })
    expect(parseCliArguments(['--version'])).toEqual({ kind: 'version' })
    expect(parseCliArguments(['version'])).toEqual({ kind: 'version' })
  })
})

describe('applyRetention', () => {
  it('removes only expired regular lowercase JSONL files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-run-retention-'))
    temporaryDirectories.push(directory)
    const expired = join(directory, 'expired.jsonl')
    const current = join(directory, 'current.jsonl')
    const uppercase = join(directory, 'ignored.JSONL')
    const ordinary = join(directory, 'notes.txt')
    const directoryEntry = join(directory, 'nested.jsonl')
    await Promise.all([
      writeFile(expired, 'old'), writeFile(current, 'new'), writeFile(uppercase, 'old'),
      writeFile(ordinary, 'old'), mkdir(directoryEntry),
    ])
    await Promise.all([utimes(expired, 1, 1), utimes(uppercase, 1, 1), utimes(ordinary, 1, 1)])

    await expect(applyRetention(directory, 1, 2 * 24 * 60 * 60 * 1_000))
      .resolves.toEqual([expired])
    await expect(stat(expired)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(current, 'utf8')).toBe('new')
    expect(await readFile(uppercase, 'utf8')).toBe('old')
    expect(await readFile(ordinary, 'utf8')).toBe('old')
    expect((await stat(directoryEntry)).isDirectory()).toBe(true)
  })

  it('treats a missing trace directory as empty', async () => {
    const directory = join(tmpdir(), `dsh-agent-run-missing-${Date.now()}`)
    await expect(applyRetention(directory, 1)).resolves.toEqual([])
  })
})

describe('browser launch', () => {
  it('selects native launch commands', () => {
    const url = 'http://127.0.0.1:4318/'
    expect(browserCommand(url, 'win32')).toEqual({
      command: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', url],
    })
    expect(browserCommand(url, 'darwin')).toEqual({ command: 'open', args: [url] })
    expect(browserCommand(url, 'linux')).toEqual({ command: 'xdg-open', args: [url] })
  })

  it('contains asynchronous browser-launch failure', async () => {
    const process = new EventEmitter() as ChildProcess
    process.unref = vi.fn()
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => process.emit('error', new Error('launcher missing')))
      return process
    }) as unknown as typeof spawn
    const warn = vi.fn()

    await expect(launchBrowser('http://127.0.0.1:4318/', { spawnProcess, warn }))
      .resolves.toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('open http://127.0.0.1:4318/'))
  })

  it('detaches a successfully spawned browser command', async () => {
    const process = new EventEmitter() as ChildProcess
    process.unref = vi.fn()
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => process.emit('spawn'))
      return process
    }) as unknown as typeof spawn

    await expect(launchBrowser('http://127.0.0.1:4318/', { spawnProcess }))
      .resolves.toBe(true)
    expect(process.unref).toHaveBeenCalledOnce()
  })

  it('refuses non-loopback browser URLs', () => {
    expect(() => browserCommand('https://example.com/', 'linux')).toThrow('loopback')
  })

  it.each([
    'http://127.0.0.1:4318/&calc',
    'http://127.0.0.1:4318/?next=1',
    'http://127.0.0.1:4318/#fragment',
    'http://user@127.0.0.1:4318/',
  ])('refuses a non-root browser target %s', (url) => {
    expect(() => browserCommand(url, 'win32')).toThrow('root of an HTTP loopback viewer')
  })
})
