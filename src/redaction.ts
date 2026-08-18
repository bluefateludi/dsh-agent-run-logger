/** Text stored in place of sensitive trace content. */
export const REDACTED_VALUE = '[REDACTED]'

/** Configuration for persistence-time content redaction. */
export interface RedactionOptions {
  /** Whether credential keys and authorization tokens are removed. */
  enabled?: boolean
  /** Additional case-insensitive object-key names to remove. */
  keys?: readonly string[]
}

const DEFAULT_REDACTED_KEYS = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'clientsecret',
  'cookie',
  'password',
  'passwd',
  'privatekey',
  'refreshtoken',
  'secret',
  'setcookie',
  'token',
])

const AUTHORIZATION_TOKEN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi
const JWT_TOKEN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g

/** Return a detached value with credential-like content replaced before persistence. */
export function redactSensitiveContent(value: unknown, options: RedactionOptions = {}): unknown {
  if (options.enabled === false) return structuredClone(value)
  const keys = new Set(DEFAULT_REDACTED_KEYS)
  for (const key of options.keys ?? []) keys.add(normalizeKey(key))
  return redactValue(value, keys, new WeakMap<object, unknown>())
}

/** Normalize key spelling so common separators do not bypass matching. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Recursively redact JSON-compatible values without modifying the source. */
function redactValue(
  value: unknown,
  keys: ReadonlySet<string>,
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === 'string') return redactString(value, keys)
  if (value === null || typeof value !== 'object') return value
  const existing = seen.get(value)
  if (existing !== undefined) return existing
  if (Array.isArray(value)) {
    const output: unknown[] = []
    seen.set(value, output)
    for (const item of value) output.push(redactValue(item, keys, seen))
    return output
  }
  const output: Record<string, unknown> = {}
  seen.set(value, output)
  for (const [key, item] of Object.entries(value)) {
    output[key] = keys.has(normalizeKey(key))
      ? REDACTED_VALUE
      : redactValue(item, keys, seen)
  }
  return output
}

/** Redact structured JSON argument strings before applying token patterns. */
function redactString(value: string, keys: ReadonlySet<string>): string {
  const trimmed = value.trim()
  let safeValue = value
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      // A non-JSON trace string can still contain an authorization token.
    }
    if (parsed !== null && typeof parsed === 'object') {
      safeValue = JSON.stringify(redactValue(parsed, keys, new WeakMap<object, unknown>()))
    }
  }
  return safeValue
    .replace(AUTHORIZATION_TOKEN, (_match, scheme: string) => `${scheme} ${REDACTED_VALUE}`)
    .replace(JWT_TOKEN, REDACTED_VALUE)
}
