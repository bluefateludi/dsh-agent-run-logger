import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const web = new URL('../web/', import.meta.url)

describe('bundled viewer UI', () => {
  it('ships the dashboard regions and local assets', async () => {
    const html = await readFile(new URL('index.html', web), 'utf8')
    const script = await readFile(new URL('app.js', web), 'utf8')
    expect(html).toContain('id="session-list"')
    expect(html).toContain('id="timeline-rows"')
    expect(html).toContain('id="detail-content"')
    expect(html).toContain('id="metric-runs"')
    expect(html).toContain('src="/app.js"')
    expect(html).not.toMatch(/https?:\/\//)
    const referencedIds = [...script.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1])
    for (const id of referencedIds) expect(html).toContain(`id="${id}"`)
  })

  it('uses the documented routes, SSE events, and text-only trace rendering', async () => {
    const script = await readFile(new URL('app.js', web), 'utf8')
    expect(script).toContain("requestJson('/api/sessions')")
    expect(script).toContain("new EventSource('/api/events')")
    expect(script).toContain("addEventListener('trace.changed'")
    expect(script).toContain("runs: $('metric-runs')")
    expect(script).toContain('changes.reset?.includes(state.selectedKey)')
    expect(script).toContain('textContent')
    expect(script).not.toContain('innerHTML')
    expect(script).not.toContain('eval(')
  })

  it('includes responsive and reduced-motion behavior', async () => {
    const styles = await readFile(new URL('styles.css', web), 'utf8')
    expect(styles).toContain('@media (max-width: 1000px)')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(styles).toContain('.detail-panel.is-open')
    expect(styles).toContain('.drawer-scrim:not([hidden])')
  })
})
