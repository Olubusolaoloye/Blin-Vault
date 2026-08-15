import { describe, expect, it } from 'vitest'
import { KNOWN_SENSITIVE_FIELDS, redactForLogging, REDACTED } from './redact.js'

describe('redactForLogging', () => {
  /**
   * The control that keeps the denylist honest. Every field name this codebase
   * treats as sensitive must actually be redacted; adding one to a type without
   * covering it here fails CI.
   */
  it.each(KNOWN_SENSITIVE_FIELDS)('redacts %s', (field) => {
    const output = redactForLogging({ [field]: 'sensitive value' })
    expect(output).toEqual({ [field]: REDACTED })
  })

  it('redacts regardless of casing', () => {
    expect(redactForLogging({ SIGNATURE: 'x', SiGnAtUrE2: 'y' })).toEqual({
      SIGNATURE: REDACTED,
      SiGnAtUrE2: REDACTED,
    })
  })

  it('catches compound names by substring, over-redacting rather than under', () => {
    const output = redactForLogging({
      userOpSignature: 'x',
      sessionKeySecret: 'y',
      guardianIdentityCommitment: 'z',
    })
    expect(output).toEqual({
      userOpSignature: REDACTED,
      sessionKeySecret: REDACTED,
      guardianIdentityCommitment: REDACTED,
    })
  })

  it('keeps non-sensitive diagnostic fields, which is the point of logging', () => {
    expect(redactForLogging({ chainId: 84532, status: 'reverted', attempt: 2 })).toEqual({
      chainId: 84532,
      status: 'reverted',
      attempt: 2,
    })
  })

  it('reaches sensitive fields nested inside objects', () => {
    const output = redactForLogging({
      operation: { sender: '0xabc', signature: '0xdeadbeef' },
    })
    expect(output).toEqual({ operation: { sender: '0xabc', signature: REDACTED } })
  })

  it('reaches sensitive fields inside arrays', () => {
    const output = redactForLogging({ ops: [{ signature: 'a' }, { signature: 'b' }] })
    expect(output).toEqual({ ops: [{ signature: REDACTED }, { signature: REDACTED }] })
  })

  /**
   * A UserOperation carries the signature Invariant 6 names explicitly, and
   * calldata that can encode a recipient and amount.
   */
  it('redacts a full UserOperation while leaving it recognisable', () => {
    const output = redactForLogging({
      sender: '0xabc',
      nonce: '0x1',
      callData: '0xdeadbeef',
      signature: '0xcafe',
      maxFeePerGas: '0x1',
    })

    expect(output).toEqual({
      sender: '0xabc',
      nonce: '0x1',
      callData: REDACTED,
      signature: REDACTED,
      maxFeePerGas: '0x1',
    })
  })

  it('never mutates its input', () => {
    const input = { signature: 'secret', nested: { proof: 'secret' } }
    const snapshot = structuredClone(input)

    redactForLogging(input)

    expect(input).toEqual(snapshot)
  })

  describe('robustness — logging must not be what crashes an error handler', () => {
    it('handles a circular reference', () => {
      const cyclic: Record<string, unknown> = { chainId: 1 }
      cyclic['self'] = cyclic

      expect(() => redactForLogging(cyclic)).not.toThrow()
      expect(redactForLogging(cyclic)).toEqual({ chainId: 1, self: '[circular]' })
    })

    it('truncates pathologically deep structures rather than recursing forever', () => {
      let deep: Record<string, unknown> = { end: true }
      for (let i = 0; i < 50; i++) deep = { nested: deep }

      expect(() => redactForLogging(deep)).not.toThrow()
      expect(JSON.stringify(redactForLogging(deep))).toContain('[truncated]')
    })

    it('renders bigint, which JSON.stringify would throw on', () => {
      expect(redactForLogging({ gasCost: 10n ** 20n })).toEqual({
        gasCost: '100000000000000000000n',
      })
      expect(() => JSON.stringify(redactForLogging({ gasCost: 1n }))).not.toThrow()
    })

    it('reduces an Error to name and message, dropping any attached fields', () => {
      const error = Object.assign(new Error('boom'), { signature: '0xleak' })
      expect(redactForLogging(error)).toEqual({ name: 'Error', message: 'boom' })
    })

    it.each([
      ['null', null, null],
      ['undefined', undefined, undefined],
      ['a string', 'plain', 'plain'],
      ['a number', 42, 42],
      ['a boolean', true, true],
    ])('passes through %s', (_label, input, expected) => {
      expect(redactForLogging(input)).toBe(expected)
    })

    it('does not pass functions through', () => {
      expect(redactForLogging({ fn: () => 'x' })).toEqual({ fn: '[function]' })
    })
  })
})
