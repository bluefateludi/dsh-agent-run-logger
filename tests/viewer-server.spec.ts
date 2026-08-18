import { request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TraceChangeSet } from '../src/viewer/repository.js'
import { ViewerServer, type ViewerAddress, type ViewerRepository } from '../src/viewer/server.js'

const servers: ViewerServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.dispose()))
})

describe('ViewerServer', () => {
  it('rejects non-loopback binding even when an untyped caller bypasses TypeScript', () => {
    expect(() => new ViewerServer({
      repository: fakeRepository(),
      host: '0.0.0.0' as '127.0.0.1',
      loadAsset: () => ({ body: '', contentType: 'text/plain' }),
    })).toThrow('host must be 127.0.0.1 or ::1')
  })

  it('serves closed routes, validates Host, and clamps record pages', async () => {
    const requestedPages: unknown[] = []
    const repository = fakeRepository({ requestedPages })
    const loaded: string[] = []
    const server = new ViewerServer({
      repository,
      port: 0,
      maximumPageSize: 7,
      loadAsset: (route) => {
        loaded.push(route)
        return { body: route === '/' ? '<main>viewer</main>' : 'asset', contentType: route === '/' ? 'text/html' : 'text/plain' }
      },
    })
    servers.push(server)
    const address = await server.start()

    const sessions = await get(address, '/api/sessions')
    expect(sessions.status).toBe(200)
    expect(sessions.headers['cache-control']).toBe('no-store')
    expect(sessions.headers['content-security-policy']).toContain("default-src 'none'")
    expect(JSON.parse(sessions.body)).toMatchObject({ aggregate: { sessions: 1, runs: 2, failures: 1 } })
    expect((await get(address, '/api/sessions/c2Vzc2lvbg/records?cursor=2&limit=999')).status).toBe(200)
    expect(requestedPages).toEqual([{ cursor: 2, limit: 7 }])
    expect(JSON.parse((await get(address, '/api/sessions/c2Vzc2lvbg/records?cursor=-1')).body)).toMatchObject({ code: 'invalid_page' })

    expect((await get(address, '/')).body).toBe('<main>viewer</main>')
    expect(loaded).toEqual(['/'])
    expect(JSON.parse((await get(address, '/unknown')).body)).toMatchObject({ code: 'route_not_found' })
    expect(JSON.parse((await get(address, '/api/sessions/../secret')).body)).toMatchObject({ code: 'route_not_found' })
    const rejected = await get(address, '/', 'attacker.example')
    expect(rejected.status).toBe(421)
    expect(JSON.parse(rejected.body)).toMatchObject({ code: 'invalid_host' })
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('streams a snapshot and a polled change while containing a disconnected subscriber', async () => {
    let refreshes = 0
    const repository = fakeRepository({
      refresh: async () => {
        refreshes += 1
        return refreshes === 2 ? { changed: ['c2Vzc2lvbg'], removed: [], diagnostics: [] } : unchanged()
      },
    })
    const server = new ViewerServer({
      repository,
      port: 0,
      pollMs: 50,
      heartbeatMs: 1_000,
      loadAsset: () => ({ body: '', contentType: 'text/plain' }),
    })
    servers.push(server)
    const address = await server.start()
    const events = await readEvents(address, 2)
    expect(events).toContain('event: snapshot')
    expect(events).toContain('event: trace.changed')
    expect(events).toContain('"changed":["c2Vzc2lvbg"]')
    await new Promise((resolve) => setTimeout(resolve, 70))
    expect(refreshes).toBeGreaterThanOrEqual(2)
  })

  it('reports new diagnostics and notifies an already open dashboard', async () => {
    let refreshes = 0
    const reportDiagnostic = vi.fn()
    const diagnostic = { code: 'file-unreadable' as const, message: 'Cannot read trace file' }
    const repository = fakeRepository({
      refresh: async () => {
        refreshes += 1
        return refreshes === 2
          ? { changed: [], reset: [], removed: [], diagnostics: [diagnostic] }
          : unchanged()
      },
    })
    const server = new ViewerServer({
      repository,
      port: 0,
      pollMs: 50,
      reportDiagnostic,
      loadAsset: () => ({ body: '', contentType: 'text/plain' }),
    })
    servers.push(server)
    const events = await readEvents(await server.start(), 2)

    expect(events).toContain('event: trace.changed')
    expect(reportDiagnostic).toHaveBeenCalledOnce()
    expect(reportDiagnostic).toHaveBeenCalledWith(diagnostic)
  })

  it('never overlaps refreshes and disposal waits for an active poll to finish', async () => {
    let active = 0
    let maximumActive = 0
    let refreshes = 0
    let release: (() => void) | undefined
    const repository = fakeRepository({
      refresh: async () => {
        refreshes += 1
        if (refreshes === 1) return unchanged()
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise<void>((resolve) => { release = resolve })
        active -= 1
        return unchanged()
      },
    })
    const server = new ViewerServer({
      repository,
      port: 0,
      pollMs: 50,
      heartbeatMs: 1_000,
      loadAsset: () => ({ body: '', contentType: 'text/plain' }),
    })
    servers.push(server)
    await server.start()
    await waitFor(() => active === 1)
    const disposal = server.dispose()
    let disposed = false
    void disposal.then(() => { disposed = true })
    await new Promise((resolve) => setTimeout(resolve, 70))
    expect(disposed).toBe(false)
    expect(maximumActive).toBe(1)
    release?.()
    await disposal
    expect(active).toBe(0)
    expect(await server.dispose()).toBeUndefined()
  })

  it('shares one concurrent startup and one loopback listener', async () => {
    let refreshes = 0
    let release: (() => void) | undefined
    const repository = fakeRepository({
      refresh: async () => {
        refreshes += 1
        await new Promise<void>((resolve) => { release = resolve })
        return unchanged()
      },
    })
    const server = new ViewerServer({
      repository,
      port: 0,
      loadAsset: () => ({ body: '', contentType: 'text/plain' }),
    })
    servers.push(server)

    const first = server.start()
    const second = server.start()
    expect(second).toBe(first)
    expect(refreshes).toBe(1)
    release?.()
    const [firstAddress, secondAddress] = await Promise.all([first, second])
    expect(secondAddress).toEqual(firstAddress)
    expect((await get(firstAddress, '/api/sessions')).status).toBe(200)
  })

  it('makes disposal during startup wait without leaving a listener', async () => {
    let release: (() => void) | undefined
    const repository = fakeRepository({
      refresh: async () => {
        await new Promise<void>((resolve) => { release = resolve })
        return unchanged()
      },
    })
    const server = new ViewerServer({
      repository,
      port: 0,
      loadAsset: () => ({ body: '', contentType: 'text/plain' }),
    })
    servers.push(server)

    const starting = server.start()
    const disposal = server.dispose()
    let disposed = false
    void disposal.then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release?.()
    await expect(starting).rejects.toThrow('disposed')
    await disposal
    await expect(server.start()).rejects.toThrow('disposed')
  })

  it('rejects excess SSE subscribers and disconnects a slow writer', async () => {
    const server = new ViewerServer({
      repository: fakeRepository(),
      port: 0,
      maximumSubscribers: 1,
      loadAsset: () => ({ body: '', contentType: 'text/plain' }),
    })
    servers.push(server)
    const address = await server.start()
    const first = openEventStream(address)
    await first.connected

    const rejected = await get(address, '/api/events')
    expect(rejected.status).toBe(503)
    expect(JSON.parse(rejected.body)).toMatchObject({ code: 'subscriber_limit' })

    const response = {
      destroyed: false,
      writableEnded: false,
      write: vi.fn(() => false),
      destroy: vi.fn(),
    }
    const internal = server as unknown as { send(target: typeof response, event: string, data: unknown): void }
    internal.send(response, 'heartbeat', { time: 1 })
    expect(response.destroy).toHaveBeenCalledOnce()
    first.close()
  })
})

function fakeRepository(options: {
  readonly requestedPages?: unknown[]
  readonly refresh?: () => Promise<TraceChangeSet>
} = {}): ViewerRepository {
  const summary = {
    key: 'c2Vzc2lvbg', sessionId: 'session', recordCount: 3, runCount: 2, failureCount: 1,
    modelTimeMs: 10, toolTimeMs: 20, totalTokens: 30, gapCount: 1, truncatedValueCount: 1,
    diagnosticCount: 0, incompatible: false,
  }
  return {
    refresh: options.refresh ?? (async () => unchanged()),
    list: () => [summary],
    detail: (key) => key === summary.key ? { summary, lineage: { children: [] }, diagnostics: [], runs: [] } : undefined,
    records: async (_key, page) => {
      options.requestedPages?.push(page)
      return { records: [], cursor: page.cursor ?? 0, total: 0 }
    },
  }
}

function unchanged(): TraceChangeSet {
  return { changed: [], removed: [], diagnostics: [] }
}

function get(address: ViewerAddress, path: string, host = `127.0.0.1:${address.port}`): Promise<{
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname: address.host, port: address.port, path, headers: { Host: host } }, (incoming) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.on('end', () => resolve({
        status: incoming.statusCode ?? 0,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

function readEvents(address: ViewerAddress, count: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: address.host,
      port: address.port,
      path: '/api/events',
      headers: { Host: `127.0.0.1:${address.port}` },
    }, (incoming) => {
      let body = ''
      incoming.setEncoding('utf8')
      incoming.on('data', (chunk: string) => {
        body += chunk
        if ((body.match(/^event:/gm) ?? []).length >= count) {
          incoming.destroy()
          resolve(body)
        }
      })
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

function openEventStream(address: ViewerAddress): {
  connected: Promise<void>
  close: () => void
} {
  let close = (): void => undefined
  const connected = new Promise<void>((resolve, reject) => {
    const outgoing = request({
      hostname: address.host,
      port: address.port,
      path: '/api/events',
      headers: { Host: `127.0.0.1:${address.port}` },
    }, (incoming) => {
      incoming.once('data', () => resolve())
      close = () => {
        incoming.destroy()
        outgoing.destroy()
      }
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
  return { connected, close: () => close() }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached before timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
