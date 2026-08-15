import { describe, expect, it } from 'vitest'
import { captureContent } from '../src/content.js'

describe('captureContent', () => {
  it('keeps small JSON values intact', () => {
    expect(captureContent({ text: 'hello' }, 100)).toEqual({
      content: { text: 'hello' },
      truncated: false,
      originalBytes: 16,
      capturedBytes: 16,
    })
  })

  it('creates a bounded UTF-8-safe head and tail preview', () => {
    const captured = captureContent({ text: '你'.repeat(100) }, 64)
    expect(captured.truncated).toBe(true)
    if (!captured.truncated) throw new Error('expected truncated content')
    expect(captured.capturedBytes).toBeLessThanOrEqual(64)
    expect(Buffer.from(captured.contentPreview.head).toString('utf8')).toBe(captured.contentPreview.head)
    expect(Buffer.from(captured.contentPreview.tail).toString('utf8')).toBe(captured.contentPreview.tail)
    expect(captured.contentPreview.head).not.toContain('\uFFFD')
    expect(captured.contentPreview.tail).not.toContain('\uFFFD')
  })
})
