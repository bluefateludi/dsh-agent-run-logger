#!/usr/bin/env node

import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, readdir, readFile, unlink } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { TraceRepository } from './viewer/repository.js'
import { ViewerServer, type StaticAsset, type StaticRoute } from './viewer/server.js'

/** Default first port considered by the loopback viewer. */
export const DEFAULT_VIEWER_PORT = 4318
/** Default interval between trace repository refreshes. */
export const DEFAULT_POLL_MS = 750
/** Default number of records returned in one page. */
export const DEFAULT_PAGE_SIZE = 500
/** Lowest supported polling interval. */
export const MIN_POLL_MS = 50
/** Hard limit for one record page. */
export const MAX_PAGE_SIZE = 2_000
const VERSION = '0.2.0'
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000

const HELP = `Usage: dsh-agent-run-logger <command> [options]

Commands:
  view       Serve the local trace viewer
  help       Show this help
  version    Show the package version

View options:
  --trace-dir <path>       Trace directory (default: .dsh/traces)
  --port <number>          First loopback port to try (default: 4318)
  --poll-ms <number>       Refresh interval (default: 750, minimum: 50)
  --page-size <number>     Default record page size (default: 500, maximum: 2000)
  --no-open                Do not open the browser
  --retention-days <days>  Delete old regular JSONL files at startup
  -h, --help               Show this help
  -v, --version            Show the package version
`

/** Fully validated settings for the local viewer. */
export interface ViewCliSettings {
  readonly traceDir: string
  readonly port: number
  readonly pollMs: number
  readonly pageSize: number
  readonly openBrowser: boolean
  readonly retentionDays?: number
}

/** A CLI action that is safe to execute without further configuration parsing. */
export type CliAction =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'view'; readonly settings: ViewCliSettings }

interface ParsedCliValues {
  readonly help?: boolean
  readonly version?: boolean
  readonly 'trace-dir'?: string
  readonly port?: string
  readonly 'poll-ms'?: string
  readonly 'page-size'?: string
  readonly 'no-open'?: boolean
  readonly 'retention-days'?: string
}

/** Parse and validate CLI input without filesystem, network, or process side effects. */
export function parseCliArguments(argv: readonly string[], cwd = process.cwd()): CliAction {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        'trace-dir': { type: 'string' },
        port: { type: 'string' },
        'poll-ms': { type: 'string' },
        'page-size': { type: 'string' },
        'no-open': { type: 'boolean' },
        'retention-days': { type: 'string' },
      },
    })
  } catch (error: unknown) {
    throw new Error(`dsh-agent-run-logger: ${errorMessage(error)}`)
  }

  const values = parsed.values as ParsedCliValues
  const [command, ...extraPositionals] = parsed.positionals
  if (values.help === true || command === 'help') {
    if (extraPositionals.length > 0) throw unexpectedArguments(extraPositionals)
    return { kind: 'help' }
  }
  if (values.version === true || command === 'version') {
    if (extraPositionals.length > 0) throw unexpectedArguments(extraPositionals)
    return { kind: 'version' }
  }
  if (command === undefined) return { kind: 'help' }
  if (command !== 'view') {
    throw new Error(`dsh-agent-run-logger: unknown command ${JSON.stringify(command)}; expected "view", "help", or "version"`)
  }
  if (extraPositionals.length > 0) throw unexpectedArguments(extraPositionals)

  const traceDirValue = values['trace-dir'] ?? '.dsh/traces'
  if (traceDirValue.length === 0) {
    throw new Error('dsh-agent-run-logger: --trace-dir must not be empty')
  }
  const retentionDays = values['retention-days'] === undefined
    ? undefined
    : positiveNumber('--retention-days', values['retention-days'])
  return {
    kind: 'view',
    settings: {
      traceDir: resolve(cwd, traceDirValue),
      port: integerInRange('--port', values.port ?? String(DEFAULT_VIEWER_PORT), 0, 65_535),
      pollMs: integerInRange('--poll-ms', values['poll-ms'] ?? String(DEFAULT_POLL_MS), MIN_POLL_MS, Number.MAX_SAFE_INTEGER),
      pageSize: integerInRange('--page-size', values['page-size'] ?? String(DEFAULT_PAGE_SIZE), 1, MAX_PAGE_SIZE),
      openBrowser: values['no-open'] !== true,
      ...(retentionDays === undefined ? {} : { retentionDays }),
    },
  }
}

/** An executable and arguments that ask the host desktop to open one URL. */
export interface BrowserCommand {
  readonly command: string
  readonly args: readonly string[]
}

/** Select the platform browser launcher without executing it. */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): BrowserCommand {
  assertLoopbackUrl(url)
  switch (platform) {
    case 'win32':
      return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', url] }
    case 'darwin':
      return { command: 'open', args: [url] }
    default:
      return { command: 'xdg-open', args: [url] }
  }
}

/** Inputs that make browser launch independently testable. */
export interface BrowserLaunchOptions {
  readonly platform?: NodeJS.Platform
  readonly spawnProcess?: typeof spawn
  readonly warn?: (message: string) => void
}

/** Launch the default browser, reporting failure without stopping the viewer. */
export async function launchBrowser(url: string, options: BrowserLaunchOptions = {}): Promise<boolean> {
  const selected = browserCommand(url, options.platform)
  const spawnProcess = options.spawnProcess ?? spawn
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`))
  return await new Promise<boolean>((complete) => {
    let child: ChildProcess
    try {
      child = spawnProcess(selected.command, [...selected.args], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error: unknown) {
      warn(browserFailure(url, error))
      complete(false)
      return
    }
    child.once('error', (error) => {
      warn(browserFailure(url, error))
      complete(false)
    })
    child.once('spawn', () => {
      child.unref()
      complete(true)
    })
  })
}

/** Dependencies replaceable by focused CLI tests. */
export interface CliRuntime {
  readonly stdout?: (message: string) => void
  readonly stderr?: (message: string) => void
  readonly openBrowser?: (url: string) => Promise<boolean>
  readonly now?: () => number
}

/** Execute help, version, or the loopback viewer until it receives a stop signal. */
export async function runCli(argv: readonly string[], runtime: CliRuntime = {}): Promise<void> {
  const action = parseCliArguments(argv)
  const stdout = runtime.stdout ?? ((message: string) => process.stdout.write(message))
  const stderr = runtime.stderr ?? ((message: string) => process.stderr.write(message))
  if (action.kind === 'help') {
    stdout(HELP)
    return
  }
  if (action.kind === 'version') {
    stdout(`${VERSION}\n`)
    return
  }

  const settings = action.settings
  const repository = new TraceRepository({
    traceDirectory: settings.traceDir,
    defaultPageSize: settings.pageSize,
    maximumPageSize: MAX_PAGE_SIZE,
  })
  const server = new ViewerServer({
    repository,
    loadAsset: loadViewerAsset,
    host: '127.0.0.1',
    port: settings.port,
    pollMs: settings.pollMs,
    maximumPageSize: MAX_PAGE_SIZE,
    reportDiagnostic: (diagnostic) => stderr(`Trace diagnostic: ${diagnostic.message}\n`),
  })
  try {
    if (settings.retentionDays !== undefined) {
      const removed = await applyRetention(settings.traceDir, settings.retentionDays, runtime.now?.() ?? Date.now())
      for (const path of removed) stdout(`Removed expired trace: ${path}\n`)
    }
    const address = await server.start()
    stdout(`Viewer URL: ${address.url}\nTrace directory: ${settings.traceDir}\n`)
    if (settings.openBrowser) {
      const openBrowser = runtime.openBrowser
        ?? ((url: string) => launchBrowser(url, { warn: (message) => stderr(`${message}\n`) }))
      await openBrowser(address.url)
    }
    await waitForShutdown(server)
  } catch (error: unknown) {
    await server.dispose()
    throw error
  }
}

/** Delete only expired regular JSONL files after rejecting link candidates. */
export async function applyRetention(traceDir: string, days: number, now = Date.now()): Promise<readonly string[]> {
  const age = days * MILLISECONDS_PER_DAY
  if (!Number.isFinite(age) || age <= 0 || !Number.isFinite(now)) {
    throw new Error('dsh-agent-run-logger: retention cutoff must be finite')
  }
  let directory
  try {
    directory = await lstat(traceDir)
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) return []
    throw error
  }
  if (directory.isSymbolicLink()) {
    throw new Error(`dsh-agent-run-logger: trace directory must not be a symlink or junction: ${traceDir}`)
  }
  if (!directory.isDirectory()) {
    throw new Error(`dsh-agent-run-logger: trace directory is not a directory: ${traceDir}`)
  }

  const candidates: { path: string; modifiedAt: number; regular: boolean; link: boolean }[] = []
  for (const entry of await readdir(traceDir)) {
    if (extname(entry) !== '.jsonl') continue
    const path = resolve(traceDir, entry)
    const metadata = await lstat(path)
    candidates.push({
      path,
      modifiedAt: metadata.mtimeMs,
      regular: metadata.isFile(),
      link: metadata.isSymbolicLink(),
    })
  }
  const link = candidates.find((candidate) => candidate.link)
  if (link !== undefined) {
    throw new Error(`dsh-agent-run-logger: retention refuses symlinks and junctions: ${link.path}`)
  }
  const cutoff = now - age
  const expired = candidates.filter((candidate) => candidate.regular && candidate.modifiedAt < cutoff)
  for (const candidate of expired) await unlink(candidate.path)
  return expired.map((candidate) => candidate.path)
}

/** Read one asset from the viewer's closed route map. */
async function loadViewerAsset(route: StaticRoute): Promise<StaticAsset> {
  const selected = {
    '/': { filename: 'index.html', contentType: 'text/html; charset=utf-8' },
    '/app.js': { filename: 'app.js', contentType: 'text/javascript; charset=utf-8' },
    '/styles.css': { filename: 'styles.css', contentType: 'text/css; charset=utf-8' },
  }[route]
  return {
    body: await readFile(new URL(`../web/${selected.filename}`, import.meta.url)),
    contentType: selected.contentType,
  }
}

/** Dispose once after either supported termination signal. */
function waitForShutdown(server: ViewerServer): Promise<void> {
  return new Promise((complete, reject) => {
    let stopping = false
    const stop = (): void => {
      if (stopping) return
      stopping = true
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      void server.dispose().then(complete, reject)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

/** Reject a numeric option outside its documented integral range. */
function integerInRange(name: string, source: string, minimum: number, maximum: number): number {
  if (!/^(?:0|[1-9]\d*)$/.test(source)) {
    throw new Error(`dsh-agent-run-logger: ${name} must be an integer from ${minimum} to ${maximum}`)
  }
  const value = Number(source)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`dsh-agent-run-logger: ${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

/** Reject a retention duration that cannot define a finite cutoff. */
function positiveNumber(name: string, source: string): number {
  if (source.trim().length === 0) throw new Error(`dsh-agent-run-logger: ${name} must be a positive number`)
  const value = Number(source)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`dsh-agent-run-logger: ${name} must be a positive number`)
  }
  return value
}

/** Keep browser invocation limited to the exact root of a loopback viewer. */
function assertLoopbackUrl(source: string): void {
  let url: URL
  try {
    url = new URL(source)
  } catch {
    throw new Error(`dsh-agent-run-logger: browser URL is invalid: ${JSON.stringify(source)}`)
  }
  const safeHost = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  const safeRoot = url.username.length === 0
    && url.password.length === 0
    && url.pathname === '/'
    && url.search.length === 0
    && url.hash.length === 0
    && /^\d+$/.test(url.port)
  if (url.protocol !== 'http:' || !safeHost || !safeRoot) {
    throw new Error('dsh-agent-run-logger: browser URL must be the root of an HTTP loopback viewer with an explicit port')
  }
}

/** Format one browser failure while preserving the URL for manual navigation. */
function browserFailure(url: string, error: unknown): string {
  return `dsh-agent-run-logger: could not open a browser (${errorMessage(error)}); open ${url}`
}

/** Extract a concise diagnostic from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Report positionals that cannot be interpreted as viewer settings. */
function unexpectedArguments(values: readonly string[]): Error {
  return new Error(`dsh-agent-run-logger: unexpected argument${values.length === 1 ? '' : 's'} ${values.map((value) => JSON.stringify(value)).join(', ')}`)
}

/** Whether one filesystem failure reports a stable Node error code. */
function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  void runCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`)
    process.exitCode = 1
  })
}
