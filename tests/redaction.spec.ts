import { describe, expect, it } from 'vitest'
import { REDACTED_VALUE, redactSensitiveContent } from '../src/redaction.js'

describe('redactSensitiveContent', () => {
  it('redacts credential-like keys recursively without modifying the input', () => {
    const input = {
      Authorization: 'Bearer visible-at-source',
      nested: [{ api_key: 'secret-key', harmless: 'kept' }],
    }

    expect(redactSensitiveContent(input)).toEqual({
      Authorization: REDACTED_VALUE,
      nested: [{ api_key: REDACTED_VALUE, harmless: 'kept' }],
    })
    expect(input.nested[0]?.api_key).toBe('secret-key')
  })

  it('supports additional case-insensitive key names', () => {
    expect(redactSensitiveContent(
      { TenantCredential: 'secret', ordinary: 'kept' },
      { keys: ['tenant_credential'] },
    )).toEqual({ TenantCredential: REDACTED_VALUE, ordinary: 'kept' })
  })

  it('redacts authorization schemes and JWT-like strings', () => {
    const jwt = 'abcdefgh.ijklmnop.qrstuvwx'
    expect(redactSensitiveContent(`Bearer abc.def-123 and ${jwt}`))
      .toBe(`Bearer ${REDACTED_VALUE} and ${REDACTED_VALUE}`)
    expect(redactSensitiveContent('Basic dXNlcjpwYXNz')).toBe(`Basic ${REDACTED_VALUE}`)
  })

  it('redacts credential keys inside JSON tool-argument strings', () => {
    const redacted = redactSensitiveContent('{"apiKey":"secret","x":1}')
    expect(redacted).toBe('{"apiKey":"[REDACTED]","x":1}')
    expect(redacted).not.toContain('secret')
  })

  it('can be disabled explicitly', () => {
    const input = { password: 'visible', header: 'Bearer visible' }
    expect(redactSensitiveContent(input, { enabled: false })).toEqual(input)
  })
})
