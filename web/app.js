const $ = (id) => document.getElementById(id)

const elements = {
  connectionLabel: $('connection-label'),
  clock: $('trace-clock'),
  sessionList: $('session-list'),
  sessionCount: $('session-count'),
  sessionSearch: $('session-search'),
  statusFilter: $('status-filter'),
  emptySessions: $('empty-sessions'),
  globalDiagnostics: $('global-diagnostics'),
  activeSession: $('active-session'),
  activeStatus: $('active-status'),
  activeRange: $('active-range'),
  timeline: $('timeline'),
  timelineRows: $('timeline-rows'),
  timeAxis: $('time-axis'),
  emptyTimeline: $('empty-timeline'),
  timelineDiagnostics: $('timeline-diagnostics'),
  detailPanel: $('detail-panel'),
  detailEmpty: $('detail-empty'),
  detailContent: $('detail-content'),
  detailKind: $('detail-kind'),
  detailTitle: $('detail-title'),
  detailSubtitle: $('detail-subtitle'),
  detailFacts: $('detail-facts'),
  sensitiveSection: $('sensitive-section'),
  contentJson: $('content-json'),
  rawJson: $('raw-json'),
  drawerScrim: $('drawer-scrim'),
  footerStatus: $('footer-status'),
  recordCount: $('record-count'),
  zoomLabel: $('zoom-label'),
  toastRegion: $('toast-region'),
  metrics: {
    runs: $('metric-runs'), failures: $('metric-failures'), model: $('metric-model'),
    tools: $('metric-tools'), tokens: $('metric-tokens'), gaps: $('metric-gaps'),
    truncated: $('metric-truncated'),
  },
}

const state = {
  sessions: [],
  aggregate: emptyAggregate(),
  selectedKey: undefined,
  detail: undefined,
  records: [],
  recordTotal: 0,
  rows: [],
  selectedRow: -1,
  requestGeneration: 0,
  activeKinds: new Set(['run', 'step', 'llm', 'tool', 'warning']),
  zoom: 1,
}

function emptyAggregate() {
  return { sessions: 0, runs: 0, failures: 0, modelTimeMs: 0, toolTimeMs: 0, totalTokens: 0, gaps: 0, truncatedValues: 0 }
}

async function requestJson(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' } })
  const value = await response.json().catch(() => ({ code: 'invalid_json', message: 'Viewer returned an invalid response.' }))
  if (!response.ok) throw new Error(value.message || `${response.status} ${response.statusText}`)
  return value
}

async function refreshSessions(payload) {
  try {
    const value = payload ?? await requestJson('/api/sessions')
    state.sessions = Array.isArray(value.sessions) ? value.sessions : []
    state.aggregate = value.aggregate ?? emptyAggregate()
    renderSummary()
    renderGlobalDiagnostics(value.diagnostics ?? [])
    renderSessions()
  } catch (error) {
    setConnection('offline', 'offline')
    toast(error.message)
  }
}

function renderSummary() {
  elements.metrics.runs.textContent = formatNumber(state.aggregate.runs)
  elements.metrics.failures.textContent = formatNumber(state.aggregate.failures)
  elements.metrics.model.textContent = formatDuration(state.aggregate.modelTimeMs)
  elements.metrics.tools.textContent = formatDuration(state.aggregate.toolTimeMs)
  elements.metrics.tokens.textContent = formatCompact(state.aggregate.totalTokens)
  elements.metrics.gaps.textContent = formatNumber(state.aggregate.gaps)
  elements.metrics.truncated.textContent = formatNumber(state.aggregate.truncatedValues)
  elements.sessionCount.textContent = String(state.sessions.length)
}

function renderGlobalDiagnostics(diagnostics) {
  elements.globalDiagnostics.replaceChildren(...diagnostics.map(diagnosticNode))
}

function diagnosticNode(diagnostic) {
  const node = document.createElement('div')
  node.className = 'diagnostic'
  node.textContent = diagnostic.message ?? diagnostic.code ?? 'Trace diagnostic'
  return node
}

function filteredSessions() {
  const search = elements.sessionSearch.value.trim().toLocaleLowerCase()
  const status = elements.statusFilter.value
  return state.sessions.filter((session) => {
    const matchesSearch = search.length === 0
      || String(session.sessionId ?? '').toLocaleLowerCase().includes(search)
      || String(session.key).toLocaleLowerCase().includes(search)
    if (!matchesSearch) return false
    if (status === 'failed') return session.failureCount > 0
    if (status === 'warning') return session.gapCount > 0 || session.diagnosticCount > 0 || session.truncatedValueCount > 0
    if (status === 'live') return isLive(session)
    return true
  })
}

function renderSessions() {
  const sessions = filteredSessions()
  const included = new Set(sessions.map((session) => session.key))
  const byId = new Map(sessions.filter((session) => session.sessionId).map((session) => [session.sessionId, session]))
  const children = new Map()
  for (const session of sessions) {
    if (!session.parentSessionId || !byId.has(session.parentSessionId)) continue
    const list = children.get(session.parentSessionId) ?? []
    list.push(session)
    children.set(session.parentSessionId, list)
  }
  const roots = sessions.filter((session) => !session.parentSessionId || !byId.has(session.parentSessionId))
  const nodes = []
  const seen = new Set()
  const append = (session, depth) => {
    if (seen.has(session.key) || !included.has(session.key)) return
    seen.add(session.key)
    const branch = document.createElement('div')
    branch.className = `session-branch depth-${Math.min(depth, 1)}`
    if (depth === 0 && session.parentSessionId && !byId.has(session.parentSessionId)) {
      const external = document.createElement('div')
      external.className = 'external-parent'
      external.textContent = `external parent · ${session.parentSessionId}`
      branch.append(external)
    }
    branch.append(sessionButton(session, depth))
    nodes.push(branch)
    for (const child of children.get(session.sessionId) ?? []) append(child, depth + 1)
  }
  for (const root of roots) append(root, 0)
  for (const session of sessions) append(session, 0)
  elements.sessionList.replaceChildren(...nodes)
  elements.emptySessions.hidden = sessions.length !== 0
}

function sessionButton(session, depth) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `session-card${session.key === state.selectedKey ? ' is-selected' : ''}`
  button.style.setProperty('--depth', String(Math.min(depth, 4)))
  button.dataset.key = session.key
  const signal = document.createElement('span')
  signal.className = `signal-dot${session.failureCount > 0 ? ' failed' : isLive(session) ? ' live' : ''}`
  const copy = document.createElement('span')
  copy.className = 'session-copy'
  const id = document.createElement('strong')
  id.className = 'session-id'
  id.textContent = session.sessionId ?? session.key
  const meta = document.createElement('span')
  meta.className = 'session-meta'
  meta.textContent = `${session.runCount} run · ${session.recordCount} rec${session.failureCount ? ` · ${session.failureCount} fail` : ''}`
  copy.append(id, meta)
  const age = document.createElement('time')
  age.className = 'session-age'
  age.textContent = relativeTime(session.lastTime)
  button.append(signal, copy, age)
  button.addEventListener('click', () => { void selectSession(session.key) })
  return button
}

async function selectSession(key) {
  const generation = ++state.requestGeneration
  state.selectedKey = key
  state.selectedRow = -1
  state.records = []
  state.recordTotal = 0
  renderSessions()
  elements.emptyTimeline.hidden = true
  elements.timelineRows.replaceChildren()
  elements.activeSession.textContent = state.sessions.find((session) => session.key === key)?.sessionId ?? key
  try {
    const [detail] = await Promise.all([requestJson(`/api/sessions/${encodeURIComponent(key)}`), loadRecordPages(key, 0, generation)])
    if (generation !== state.requestGeneration) return
    state.detail = detail
    renderSelectedSession()
  } catch (error) {
    if (generation !== state.requestGeneration) return
    toast(error.message)
    elements.emptyTimeline.hidden = false
  }
}

async function loadRecordPages(key, cursor, generation) {
  let next = cursor
  let first = true
  while (next !== undefined && state.records.length < 20_000) {
    const page = await requestJson(`/api/sessions/${encodeURIComponent(key)}/records?cursor=${next}&limit=2000`)
    if (generation !== state.requestGeneration || key !== state.selectedKey) return
    if (first && cursor > 0 && Number(page.total) < state.records.length) {
      state.records = []
      next = 0
      first = false
      continue
    }
    state.records.push(...(Array.isArray(page.records) ? page.records : []))
    state.recordTotal = Number(page.total) || state.records.length
    next = Number.isInteger(page.nextCursor) ? page.nextCursor : undefined
    first = false
  }
  if (next !== undefined) toast('Timeline is limited to the first 20,000 records in this browser view.')
}

async function refreshSelected(changes) {
  if (!state.selectedKey) return
  if (changes.removed?.includes(state.selectedKey)) {
    clearSelection()
    return
  }
  if (!changes.changed?.includes(state.selectedKey)) return
  const generation = state.requestGeneration
  try {
    const detail = await requestJson(`/api/sessions/${encodeURIComponent(state.selectedKey)}`)
    const reset = changes.reset?.includes(state.selectedKey) === true
    if (reset) {
      state.records = []
      state.recordTotal = 0
    }
    await loadRecordPages(state.selectedKey, reset ? 0 : state.records.length, generation)
    if (generation !== state.requestGeneration) return
    state.detail = detail
    renderSelectedSession()
  } catch (error) {
    toast(error.message)
  }
}

function clearSelection() {
  state.requestGeneration += 1
  state.selectedKey = undefined
  state.detail = undefined
  state.records = []
  state.rows = []
  renderSessions()
  elements.timelineRows.replaceChildren()
  elements.emptyTimeline.hidden = false
  elements.activeSession.textContent = 'Select a session'
  elements.activeRange.textContent = '—'
  elements.recordCount.textContent = '0 records indexed'
  clearDetail()
}

function renderSelectedSession() {
  const summary = state.detail?.summary
  if (!summary) return
  state.rows = deriveRows(state.records, state.detail.diagnostics ?? [])
  elements.activeSession.textContent = summary.sessionId ?? summary.key
  elements.activeStatus.className = `signal-dot${summary.failureCount > 0 ? ' failed' : isLive(summary) ? ' live' : ''}`
  elements.activeRange.textContent = summary.firstTime === undefined ? '—' : `${formatClock(summary.firstTime)} → ${formatClock(summary.lastTime)}`
  elements.recordCount.textContent = `${formatNumber(state.recordTotal)} records indexed`
  elements.timelineDiagnostics.replaceChildren(...(state.detail.diagnostics ?? []).map(diagnosticNode))
  renderTimeline()
}

function deriveRows(records, diagnostics) {
  const starts = new Map()
  const rows = []
  let latest = 0
  for (const record of records) {
    const time = finite(record.time, latest)
    latest = Math.max(latest, time)
    const type = String(record.type ?? 'event')
    const kind = eventKind(type)
    const pair = pairIdentity(record, type)
    if (type.endsWith('.start')) {
      starts.set(pair, record)
      continue
    }
    if (type === 'llm.first_token') {
      rows.push(rowFromRecord(record, 'llm', time - finite(record.durationMs, 0), time, 'first token'))
      continue
    }
    if (type.endsWith('.end')) {
      const start = starts.get(pair)
      const startedAt = type === 'llm.end'
        ? time - finite(record.durationMs, 0)
        : finite(start?.time, time - finite(record.durationMs, 0))
      rows.push(rowFromRecord(record, kind, startedAt, time, rowName(record, type)))
      starts.delete(pair)
      continue
    }
    if (type === 'trace.gap') rows.push(rowFromRecord(record, 'warning', time, time, 'trace gap'))
    else if (type !== 'session.meta') rows.push(rowFromRecord(record, kind, time, time, rowName(record, type)))
  }
  for (const record of starts.values()) {
    rows.push({ ...rowFromRecord(record, eventKind(record.type), finite(record.time, latest), latest, rowName(record, record.type)), live: true })
  }
  for (const diagnostic of diagnostics) {
    rows.push({ kind: 'warning', name: diagnostic.code ?? 'diagnostic', start: latest, end: latest, record: diagnostic, warning: true })
  }
  return rows.sort((left, right) => left.start - right.start || left.end - right.end)
}

function rowFromRecord(record, kind, start, end, name) {
  return {
    kind,
    name,
    start,
    end: Math.max(start, end),
    record,
    warning: kind === 'warning' || record.outcome === 'error' || record.outcome === 'incomplete',
  }
}

function pairIdentity(record, type) {
  const prefix = type.split('.')[0]
  if (prefix === 'run') return `run:${record.runId ?? record.turn ?? record.sourceSeq}`
  if (prefix === 'step' || prefix === 'llm') return `${prefix}:${record.stepId ?? `${record.turn}:${record.step}`}`
  if (prefix === 'tool') return `tool:${record.toolId ?? record.sourceSeq}`
  return `${type}:${record.sourceSeq}`
}

function eventKind(type) {
  const prefix = String(type).split('.')[0]
  return ['run', 'step', 'llm', 'tool'].includes(prefix) ? prefix : prefix === 'trace' ? 'warning' : 'event'
}

function rowName(record, type) {
  if (type.startsWith('tool.')) return record.name ? `${record.name}` : 'tool call'
  if (type.startsWith('llm.')) return record.model ? `${record.provider ?? 'model'} / ${record.model}` : 'model request'
  if (type.startsWith('step.')) return `step ${record.step ?? '—'}`
  if (type.startsWith('run.')) return `run ${record.turn ?? '—'}`
  return type
}

function visibleRows() {
  return state.rows.filter((row) => row.kind === 'event' || state.activeKinds.has(row.kind))
}

function renderTimeline() {
  const rows = visibleRows()
  const minimum = rows.length ? Math.min(...rows.map((row) => row.start)) : 0
  const maximum = rows.length ? Math.max(...rows.map((row) => row.end), minimum + 1) : 1
  const range = Math.max(1, maximum - minimum)
  elements.timelineRows.style.width = `${state.zoom * 100}%`
  elements.timeAxis.style.width = `${state.zoom * 100}%`
  renderAxis(minimum, range)
  const nodes = rows.map((row, index) => timelineRow(row, index, minimum, range))
  elements.timelineRows.replaceChildren(...nodes)
  elements.emptyTimeline.hidden = nodes.length !== 0
  if (state.selectedRow >= nodes.length) state.selectedRow = nodes.length - 1
}

function renderAxis(minimum, range) {
  const labels = [textNode('span', 'TRACE OFFSET', 'axis-label')]
  for (let index = 0; index < 5; index += 1) {
    labels.push(textNode('span', `+${formatDuration(range * index / 4)}`, 'axis-label'))
  }
  elements.timeAxis.replaceChildren(...labels)
}

function timelineRow(row, index, minimum, range) {
  const node = document.createElement('div')
  node.className = `timeline-row${index === state.selectedRow ? ' is-selected' : ''}`
  node.tabIndex = -1
  node.dataset.index = String(index)
  node.setAttribute('role', 'button')
  node.setAttribute('aria-label', `${row.kind} ${row.name}`)
  const label = document.createElement('div')
  label.className = 'row-label'
  label.append(textNode('span', row.kind, 'row-type'), textNode('span', row.name, 'row-name'))
  const track = document.createElement('div')
  track.className = 'row-track'
  const bar = document.createElement('span')
  bar.className = `span-bar ${row.kind}${row.warning ? ' is-error' : ''}${row.live ? ' is-live' : ''}`
  const left = 100 * (row.start - minimum) / range
  const width = Math.max(row.kind === 'warning' ? 0.5 : 0.35, 100 * (row.end - row.start) / range)
  bar.style.left = `${Math.max(0, left)}%`
  bar.style.width = `${Math.min(100 - left, width)}%`
  const caption = textNode('span', formatDuration(row.end - row.start), 'span-caption')
  caption.style.left = `${Math.min(96, left + width)}%`
  track.append(bar, caption)
  node.append(label, track)
  node.addEventListener('click', () => selectRow(index))
  return node
}

function selectRow(index) {
  const rows = visibleRows()
  if (index < 0 || index >= rows.length) return
  state.selectedRow = index
  renderTimeline()
  showDetail(rows[index])
}

function showDetail(row) {
  const record = row.record
  elements.detailEmpty.hidden = true
  elements.detailContent.hidden = false
  elements.detailPanel.classList.add('is-open')
  elements.drawerScrim.hidden = false
  elements.detailKind.textContent = row.kind
  elements.detailTitle.textContent = row.name
  elements.detailSubtitle.textContent = `${formatClock(row.start)} · ${formatDuration(row.end - row.start)}`
  const facts = [
    ['Type', record.type ?? record.code ?? row.kind],
    ['Outcome', record.outcome ?? (row.live ? 'live' : '—')],
    ['Source seq', record.sourceSeq ?? '—'],
    ['Duration', formatDuration(record.durationMs ?? row.end - row.start)],
    ['Run', record.runId ?? '—'],
    ['Step', record.stepId ?? '—'],
    ['Tool', record.toolId ?? record.name ?? '—'],
    ['Time', formatDateTime(record.time ?? row.start)],
  ]
  elements.detailFacts.replaceChildren(...facts.map(([name, value]) => factNode(name, value)))
  const sensitive = capturedFields(record)
  elements.sensitiveSection.hidden = Object.keys(sensitive).length === 0
  elements.contentJson.textContent = JSON.stringify(sensitive, null, 2)
  elements.rawJson.textContent = JSON.stringify(record, null, 2)
}

function factNode(name, value) {
  const wrapper = document.createElement('div')
  const term = textNode('dt', name)
  const description = textNode('dd', String(value))
  wrapper.append(term, description)
  return wrapper
}

function capturedFields(record) {
  const fields = {}
  for (const key of ['input', 'output', 'arguments', 'result', 'content', 'contentPreview']) {
    if (Object.hasOwn(record, key)) fields[key] = record[key]
  }
  return fields
}

function clearDetail() {
  elements.detailEmpty.hidden = false
  elements.detailContent.hidden = true
  elements.detailPanel.classList.remove('is-open')
  elements.drawerScrim.hidden = true
}

function connectEvents() {
  const source = new EventSource('/api/events')
  source.addEventListener('open', () => setConnection('live', 'live'))
  source.addEventListener('snapshot', (event) => {
    setConnection('live', 'live')
    void refreshSessions(parseEvent(event))
  })
  source.addEventListener('trace.changed', (event) => {
    const changes = parseEvent(event)
    void refreshSessions()
    void refreshSelected(changes)
  })
  source.addEventListener('heartbeat', () => setConnection('live', 'live'))
  source.addEventListener('error', () => setConnection('offline', 'reconnecting'))
}

function parseEvent(event) {
  try { return JSON.parse(event.data) } catch { return {} }
}

function setConnection(kind, label) {
  document.body.classList.toggle('is-live', kind === 'live')
  document.body.classList.toggle('is-offline', kind === 'offline')
  elements.connectionLabel.textContent = label
  elements.footerStatus.textContent = kind === 'live' ? 'Event stream connected' : 'Event stream reconnecting'
}

function toast(message) {
  const node = textNode('div', String(message), 'toast')
  elements.toastRegion.append(node)
  window.setTimeout(() => node.remove(), 5000)
}

function textNode(tag, value, className) {
  const node = document.createElement(tag)
  if (className) node.className = className
  node.textContent = String(value)
  return node
}

function isLive(session) {
  return Number.isFinite(session.lastTime) && Date.now() - session.lastTime < 5000
}

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(finite(value))
}

function formatCompact(value) {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(finite(value))
}

function formatDuration(value) {
  const milliseconds = Math.max(0, finite(value))
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round(milliseconds % 60_000 / 1000)}s`
}

function formatClock(value) {
  if (!Number.isFinite(Number(value))) return '—'
  return new Date(Number(value)).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDateTime(value) {
  if (!Number.isFinite(Number(value))) return '—'
  return new Date(Number(value)).toLocaleString()
}

function relativeTime(value) {
  if (!Number.isFinite(Number(value))) return '—'
  const elapsed = Math.max(0, Date.now() - Number(value))
  if (elapsed < 5000) return 'live'
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s`
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`
  return `${Math.floor(elapsed / 3_600_000)}h`
}

elements.sessionSearch.addEventListener('input', renderSessions)
elements.statusFilter.addEventListener('change', renderSessions)
elements.timeline.addEventListener('keydown', (event) => {
  if (event.key.toLocaleLowerCase() === 'j') { event.preventDefault(); selectRow(Math.min(visibleRows().length - 1, state.selectedRow + 1)) }
  if (event.key.toLocaleLowerCase() === 'k') { event.preventDefault(); selectRow(Math.max(0, state.selectedRow - 1)) }
  if (event.key === 'Enter' && state.selectedRow >= 0) { event.preventDefault(); showDetail(visibleRows()[state.selectedRow]) }
})
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== elements.sessionSearch) {
    event.preventDefault()
    elements.sessionSearch.focus()
  }
  if (event.key === 'Escape') clearDetail()
})
document.querySelectorAll('.filter-chip').forEach((button) => button.addEventListener('click', () => {
  const kind = button.dataset.kind
  if (state.activeKinds.has(kind)) state.activeKinds.delete(kind)
  else state.activeKinds.add(kind)
  button.classList.toggle('is-active', state.activeKinds.has(kind))
  state.selectedRow = -1
  renderTimeline()
}))
$('zoom-in').addEventListener('click', () => setZoom(Math.min(4, state.zoom + 0.25)))
$('zoom-out').addEventListener('click', () => setZoom(Math.max(1, state.zoom - 0.25)))
$('close-detail').addEventListener('click', clearDetail)
elements.drawerScrim.addEventListener('click', clearDetail)

function setZoom(value) {
  state.zoom = value
  elements.zoomLabel.textContent = `${Math.round(value * 100)}%`
  renderTimeline()
}

window.setInterval(() => { elements.clock.textContent = new Date().toLocaleTimeString([], { hour12: false }) }, 250)
void refreshSessions()
connectEvents()
