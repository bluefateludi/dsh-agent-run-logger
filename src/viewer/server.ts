import { createServer, type Server, type ServerResponse } from 'node:http'
import type {
  RecordPageRequest,
  SessionDetail,
  SessionQuery,
  SessionSummary,
  TraceChangeSet,
  TraceDiagnostic,
} from './repository.js'

/** The complete set of static routes exposed by the viewer. */
export type StaticRoute = '/' | '/app.js' | '/styles.css'

/** One bundled static asset returned by the closed asset loader. */
export interface StaticAsset {
  readonly body: Uint8Array | string
  readonly contentType: string
}

/** Repository interface consumed by the HTTP module. */
export interface ViewerRepository {
  refresh(): Promise<TraceChangeSet>
  list(query?: SessionQuery): readonly SessionSummary[]
  detail(key: string): SessionDetail | undefined
  records(key: string, page: RecordPageRequest): Promise<unknown>
}

/** Runtime configuration for a loopback-only viewer server. */
export interface ViewerServerOptions {
  readonly repository: ViewerRepository
  readonly loadAsset: (route: StaticRoute) => StaticAsset | Promise<StaticAsset>
  readonly host?: '127.0.0.1' | '::1'
  readonly port?: number
  readonly portSearchCount?: number
  readonly pollMs?: number
  readonly heartbeatMs?: number
  readonly maximumPageSize?: number
  readonly maximumSubscribers?: number
  readonly reportDiagnostic?: (diagnostic: TraceDiagnostic) => void
}

/** Address selected after the server starts listening. */
export interface ViewerAddress {
  readonly host: '127.0.0.1' | '::1'
  readonly port: number
  readonly url: string
}

interface AggregateSummary {
  readonly sessions: number
  readonly runs: number
  readonly failures: number
  readonly modelTimeMs: number
  readonly toolTimeMs: number
  readonly totalTokens: number
  readonly gaps: number
  readonly truncatedValues: number
}

const CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

/** Serve repository queries, closed static assets, and live changes on loopback. */
export class ViewerServer {
  private readonly repository: ViewerRepository
  private readonly loadAsset: ViewerServerOptions['loadAsset']
  private readonly host: '127.0.0.1' | '::1'
  private readonly requestedPort: number
  private readonly portSearchCount: number
  private readonly pollMs: number
  private readonly heartbeatMs: number
  private readonly maximumPageSize: number
  private readonly maximumSubscribers: number
  private readonly reportDiagnostic: (diagnostic: TraceDiagnostic) => void
  private readonly subscribers = new Set<ServerResponse>()
  private server?: Server
  private address?: ViewerAddress
  private startPromise?: Promise<ViewerAddress>
  private pollTimer?: NodeJS.Timeout
  private pollPromise?: Promise<void>
  private lastHeartbeat = 0
  private disposed = false
  private disposePromise?: Promise<void>
  private repositoryDiagnostics: readonly TraceDiagnostic[] = []
  private diagnosticSignatures = new Set<string>()

  constructor(options: ViewerServerOptions) {
    this.repository = options.repository
    this.loadAsset = options.loadAsset
    this.host = loopbackHost(options.host ?? '127.0.0.1')
    this.requestedPort = port(options.port ?? 4318)
    this.portSearchCount = positiveInteger(options.portSearchCount ?? 10, 'portSearchCount')
    this.pollMs = minimumInteger(options.pollMs ?? 750, 50, 'pollMs')
    this.heartbeatMs = minimumInteger(options.heartbeatMs ?? 15_000, this.pollMs, 'heartbeatMs')
    this.maximumPageSize = positiveInteger(options.maximumPageSize ?? 2_000, 'maximumPageSize')
    this.maximumSubscribers = positiveInteger(options.maximumSubscribers ?? 32, 'maximumSubscribers')
    this.reportDiagnostic = options.reportDiagnostic ?? (() => {})
  }

  /** Index current data, bind to loopback, and begin non-overlapping polling. */
  start(): Promise<ViewerAddress> {
    if (this.disposed) return Promise.reject(new Error('ViewerServer has been disposed'))
    if (this.address !== undefined) return Promise.resolve(this.address)
    if (this.startPromise !== undefined) return this.startPromise
    const starting = this.startOwned()
    this.startPromise = starting
    void starting.then(
      () => { if (this.startPromise === starting) this.startPromise = undefined },
      () => { if (this.startPromise === starting) this.startPromise = undefined },
    )
    return starting
  }

  private async startOwned(): Promise<ViewerAddress> {
    const initial = await this.repository.refresh()
    if (this.disposed) throw new Error('ViewerServer has been disposed')
    this.setDiagnostics(initial.diagnostics)

    const attempts = this.requestedPort === 0 ? 1 : this.portSearchCount
    let lastError: unknown
    for (let offset = 0; offset < attempts; offset += 1) {
      const candidate = this.requestedPort + offset
      if (candidate > 65_535) break
      const server = createServer((request, response) => {
        void this.handle(request.method, request.url, request.headers.host, response).catch((error: unknown) => {
          if (!response.headersSent) this.json(response, 500, { code: 'internal_error', message: 'The viewer could not complete this request.' })
          else response.destroy(error instanceof Error ? error : undefined)
        })
      })
      try {
        const selectedPort = await listen(server, candidate, this.host)
        if (this.disposed) {
          await closeServer(server)
          throw new Error('ViewerServer has been disposed')
        }
        this.server = server
        this.address = {
          host: this.host,
          port: selectedPort,
          url: `http://${this.host === '::1' ? '[::1]' : this.host}:${selectedPort}/`,
        }
        this.lastHeartbeat = Date.now()
        this.schedulePoll()
        return this.address
      } catch (error: unknown) {
        lastError = error
        await closeAfterListenFailure(server)
        if (!hasCode(error, 'EADDRINUSE') || this.requestedPort === 0) throw error
      }
    }
    throw new Error(`No available loopback port in ${this.requestedPort}-${this.requestedPort + attempts - 1}: ${errorMessage(lastError)}`)
  }

  /** Stop polling and SSE clients before waiting for the HTTP listener to quiesce. */
  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.disposed = true
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer)
    this.pollTimer = undefined
    for (const subscriber of this.subscribers) subscriber.end()
    this.subscribers.clear()
    this.disposePromise = this.quiesce(this.startPromise)
    return this.disposePromise
  }

  private async quiesce(starting: Promise<ViewerAddress> | undefined): Promise<void> {
    try {
      await starting
    } catch {
      // Disposal owns a concurrent startup failure and still closes every resource it created.
    }
    await this.pollPromise
    const server = this.server
    this.server = undefined
    this.address = undefined
    if (server !== undefined) await closeServer(server)
  }

  private async handle(
    method: string | undefined,
    requestUrl: string | undefined,
    hostHeader: string | undefined,
    response: ServerResponse,
  ): Promise<void> {
    if (this.address === undefined || !validHost(hostHeader, this.address.port)) {
      this.json(response, 421, { code: 'invalid_host', message: 'Use the loopback viewer URL printed by the command.' })
      return
    }
    if (method !== 'GET') {
      response.setHeader('Allow', 'GET')
      this.json(response, 405, { code: 'method_not_allowed', message: 'The viewer accepts GET requests only.' })
      return
    }
    let url: URL
    try {
      url = new URL(requestUrl ?? '/', this.address.url)
    } catch {
      this.json(response, 400, { code: 'invalid_url', message: 'Use a valid viewer path and query string.' })
      return
    }
    if (url.pathname === '/api/sessions') {
      const query: SessionQuery = {
        ...(url.searchParams.has('search') ? { search: url.searchParams.get('search') ?? '' } : {}),
        ...(url.searchParams.get('failures') === 'true' ? { failuresOnly: true } : {}),
      }
      const sessions = this.repository.list(query)
      this.json(response, 200, { sessions, aggregate: aggregate(sessions), diagnostics: this.repositoryDiagnostics })
      return
    }
    if (url.pathname === '/api/events') {
      this.subscribe(response)
      return
    }
    const recordsMatch = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/records$/.exec(url.pathname)
    if (recordsMatch?.[1] !== undefined) {
      const request = pageRequest(url, this.maximumPageSize)
      if ('error' in request) {
        this.json(response, 400, request.error)
        return
      }
      const page = await this.repository.records(recordsMatch[1], request)
      this.json(response, 200, page)
      return
    }
    const detailMatch = /^\/api\/sessions\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
    if (detailMatch?.[1] !== undefined) {
      const detail = this.repository.detail(detailMatch[1])
      if (detail === undefined) {
        this.json(response, 404, { code: 'session_not_found', message: 'Refresh the session list and choose an available trace.' })
      } else {
        this.json(response, 200, detail)
      }
      return
    }
    if (isStaticRoute(url.pathname)) {
      const asset = await this.loadAsset(url.pathname)
      response.writeHead(200, this.headers({
        'Content-Type': asset.contentType,
        'Cache-Control': 'no-cache',
      }))
      response.end(asset.body)
      return
    }
    this.json(response, 404, { code: 'route_not_found', message: 'Use a documented viewer route.' })
  }

  private subscribe(response: ServerResponse): void {
    if (this.subscribers.size >= this.maximumSubscribers) {
      this.json(response, 503, { code: 'subscriber_limit', message: 'Close another live viewer connection and retry.' })
      return
    }
    response.writeHead(200, this.headers({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    }))
    this.subscribers.add(response)
    const remove = (): void => { this.subscribers.delete(response) }
    response.once('close', remove)
    response.once('error', remove)
    if (!response.write(': connected\n\n')) {
      this.disconnect(response)
      return
    }
    this.send(response, 'snapshot', {
      sessions: this.repository.list(),
      aggregate: aggregate(this.repository.list()),
      diagnostics: this.repositoryDiagnostics,
    })
  }

  private schedulePoll(): void {
    if (this.disposed) return
    this.pollTimer = setTimeout(() => {
      const polling = this.poll()
      this.pollPromise = polling
      void polling.finally(() => {
        if (this.pollPromise === polling) this.pollPromise = undefined
      })
    }, this.pollMs)
    this.pollTimer.unref()
  }

  private async poll(): Promise<void> {
    if (this.disposed) return
    try {
      const changes = await this.repository.refresh()
      const diagnosticsChanged = this.setDiagnostics(changes.diagnostics)
      if (changes.changed.length > 0 || changes.removed.length > 0 || diagnosticsChanged) {
        this.broadcast('trace.changed', changes)
      }
      const now = Date.now()
      if (now - this.lastHeartbeat >= this.heartbeatMs) {
        this.broadcast('heartbeat', { time: now })
        this.lastHeartbeat = now
      }
    } catch (error: unknown) {
      const diagnostics: readonly TraceDiagnostic[] = [{ code: 'directory-unreadable', message: `Trace refresh failed: ${errorMessage(error)}` }]
      if (this.setDiagnostics(diagnostics)) {
        this.broadcast('trace.changed', { changed: [], reset: [], removed: [], diagnostics })
      }
    } finally {
      this.schedulePoll()
    }
  }

  private broadcast(event: string, data: unknown): void {
    for (const subscriber of [...this.subscribers]) this.send(subscriber, event, data)
  }

  private send(response: ServerResponse, event: string, data: unknown): void {
    try {
      if (response.destroyed || response.writableEnded) {
        this.subscribers.delete(response)
        return
      }
      if (!response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) this.disconnect(response)
    } catch {
      // A disconnected SSE subscriber cannot affect repository polling or other clients.
      this.disconnect(response)
    }
  }

  private disconnect(response: ServerResponse): void {
    this.subscribers.delete(response)
    response.destroy()
  }

  private setDiagnostics(diagnostics: readonly TraceDiagnostic[]): boolean {
    const signatures = new Set(diagnostics.map(diagnosticSignature))
    const changed = !sameSet(signatures, this.diagnosticSignatures)
    if (!changed) return false
    for (let index = 0; index < diagnostics.length; index += 1) {
      const diagnostic = diagnostics[index]!
      if (!this.diagnosticSignatures.has(diagnosticSignature(diagnostic))) this.reportDiagnostic(diagnostic)
    }
    this.repositoryDiagnostics = diagnostics
    this.diagnosticSignatures = signatures
    return true
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, this.headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    }))
    response.end(JSON.stringify(value))
  }

  private headers(additional: Record<string, string>): Record<string, string> {
    return {
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...additional,
    }
  }
}

function aggregate(sessions: readonly SessionSummary[]): AggregateSummary {
  return sessions.reduce<AggregateSummary>((result, session) => ({
    sessions: result.sessions + 1,
    runs: result.runs + session.runCount,
    failures: result.failures + session.failureCount,
    modelTimeMs: result.modelTimeMs + session.modelTimeMs,
    toolTimeMs: result.toolTimeMs + session.toolTimeMs,
    totalTokens: result.totalTokens + session.totalTokens,
    gaps: result.gaps + session.gapCount,
    truncatedValues: result.truncatedValues + session.truncatedValueCount,
  }), { sessions: 0, runs: 0, failures: 0, modelTimeMs: 0, toolTimeMs: 0, totalTokens: 0, gaps: 0, truncatedValues: 0 })
}

function pageRequest(url: URL, maximumPageSize: number): RecordPageRequest | { error: { code: string; message: string } } {
  const cursor = integerParameter(url, 'cursor', 0)
  const limit = integerParameter(url, 'limit', 1)
  if (cursor === undefined || limit === undefined) {
    return { error: { code: 'invalid_page', message: 'cursor must be a non-negative integer and limit must be a positive integer.' } }
  }
  return {
    ...(cursor === null ? {} : { cursor }),
    ...(limit === null ? {} : { limit: Math.min(limit, maximumPageSize) }),
  }
}

function integerParameter(url: URL, name: string, minimum: number): number | null | undefined {
  const raw = url.searchParams.get(name)
  if (raw === null) return null
  if (!/^\d+$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= minimum ? value : undefined
}

function isStaticRoute(pathname: string): pathname is StaticRoute {
  return pathname === '/' || pathname === '/app.js' || pathname === '/styles.css'
}

function validHost(value: string | undefined, boundPort: number): boolean {
  if (value === undefined || value.includes(',') || /[\r\n]/.test(value)) return false
  const normalized = value.toLocaleLowerCase()
  return normalized === `127.0.0.1:${boundPort}`
    || normalized === `localhost:${boundPort}`
    || normalized === `[::1]:${boundPort}`
}

function listen(server: Server, selectedPort: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(selectedPort, host, () => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('HTTP server did not report a TCP address'))
      } else {
        resolve(address.port)
      }
    })
  })
}

function closeAfterListenFailure(server: Server): Promise<void> {
  return server.listening ? closeServer(server) : Promise.resolve()
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeIdleConnections()
    server.close((error) => error === undefined ? resolve() : reject(error))
  })
}

function port(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) throw new Error('port must be an integer from 0 through 65535')
  return value
}

function loopbackHost(value: unknown): '127.0.0.1' | '::1' {
  if (value !== '127.0.0.1' && value !== '::1') throw new Error('host must be 127.0.0.1 or ::1')
  return value
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  return value
}

function minimumInteger(value: number, minimum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer of at least ${minimum}`)
  return value
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function diagnosticSignature(diagnostic: TraceDiagnostic): string {
  return JSON.stringify([diagnostic.code, diagnostic.message, diagnostic.line, diagnostic.byteOffset])
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value))
}
