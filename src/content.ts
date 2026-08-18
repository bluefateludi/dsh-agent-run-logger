import type { CapturedContent } from './types.js'
import { redactSensitiveContent, type RedactionOptions } from './redaction.js'

/** Return the longest prefix whose UTF-8 encoding fits the requested byte count. */
function utf8Prefix(value: string, maxBytes: number): string {
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle
    else high = middle - 1
  }
  if (low > 0 && low < value.length
    && isHighSurrogate(value.charCodeAt(low - 1))
    && isLowSurrogate(value.charCodeAt(low))) low -= 1
  return value.slice(0, low)
}

/** Return the longest suffix whose UTF-8 encoding fits the requested byte count. */
function utf8Suffix(value: string, maxBytes: number): string {
  let low = 0
  let high = value.length
  while (low < high) {
    const length = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(value.length - length)) <= maxBytes) low = length
    else high = length - 1
  }
  let start = value.length - low
  if (start > 0 && start < value.length
    && isHighSurrogate(value.charCodeAt(start - 1))
    && isLowSurrogate(value.charCodeAt(start))) start += 1
  return value.slice(start)
}

/** Whether one UTF-16 code unit opens a surrogate pair. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF
}

/** Whether one UTF-16 code unit closes a surrogate pair. */
function isLowSurrogate(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF
}

/** Redact and capture a JSON value without exceeding its configured UTF-8 content budget. */
export function captureContent(
  value: unknown,
  maxBytes: number,
  redaction: RedactionOptions = {},
): CapturedContent {
  const safeValue = redactSensitiveContent(value, redaction)
  const serialized = JSON.stringify(safeValue) ?? 'null'
  const originalBytes = Buffer.byteLength(serialized)
  if (originalBytes <= maxBytes) {
    return {
      content: safeValue,
      truncated: false,
      originalBytes,
      capturedBytes: originalBytes,
    }
  }
  const headBudget = Math.floor(maxBytes * 0.75)
  const tailBudget = maxBytes - headBudget
  const head = utf8Prefix(serialized, headBudget)
  const tail = utf8Suffix(serialized, tailBudget)
  return {
    contentPreview: { head, tail },
    truncated: true,
    originalBytes,
    capturedBytes: Buffer.byteLength(head) + Buffer.byteLength(tail),
  }
}
