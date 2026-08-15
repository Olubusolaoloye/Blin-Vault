import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import {
  AddressSchema,
  ChainIdSchema,
  Hash32Schema,
  HexSchema,
  QuantitySchema,
} from './primitives.js'

const LOWER = '0x6c8b714529b0fe3920152432ac6e7d85f5b6e7a2'
const CHECKSUMMED = getAddress(LOWER)

describe('AddressSchema', () => {
  it('accepts a correctly checksummed address', () => {
    expect(AddressSchema.parse(CHECKSUMMED)).toBe(CHECKSUMMED)
  })

  it('accepts all-lowercase, which carries no checksum to verify', () => {
    expect(AddressSchema.parse(LOWER)).toBe(CHECKSUMMED)
  })

  it('normalises accepted input to checksummed form', () => {
    // Downstream comparisons (known-recipient tracking especially) must not
    // depend on the casing an external source happened to use.
    expect(AddressSchema.parse(LOWER)).toBe(AddressSchema.parse(CHECKSUMMED))
  })

  /**
   * The reason this schema exists rather than calling getAddress directly.
   * viem's getAddress does NOT reject a wrong checksum — it recomputes one and
   * returns the tampered address looking perfectly well-formed.
   */
  it('rejects a mixed-case address whose checksum does not match', () => {
    const tampered = CHECKSUMMED.slice(0, -1) + (CHECKSUMMED.endsWith('2') ? '3' : '2')

    expect(AddressSchema.safeParse(tampered).success).toBe(false)

    // Demonstrating the footgun this guards against: getAddress accepts it.
    expect(() => getAddress(tampered)).not.toThrow()
  })

  it('rejects all-uppercase rather than silently trusting it', () => {
    const upper = '0x' + CHECKSUMMED.slice(2).toUpperCase()
    expect(AddressSchema.safeParse(upper).success).toBe(false)
  })

  it.each([
    ['empty', ''],
    ['missing 0x prefix', LOWER.slice(2)],
    ['too short', '0x1234'],
    ['too long', LOWER + 'ab'],
    ['non-hex characters', '0xzzzz714529b0fe3920152432ac6e7d85f5b6e7a2'],
    ['whitespace padded', ` ${LOWER} `],
  ])('rejects %s', (_label, value) => {
    expect(AddressSchema.safeParse(value).success).toBe(false)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['number', 1234],
    ['object', { address: LOWER }],
    ['array', [LOWER]],
  ])('rejects non-string input: %s', (_label, value) => {
    expect(AddressSchema.safeParse(value).success).toBe(false)
  })
})

describe('HexSchema', () => {
  it.each(['0x', '0xab', '0xABCDEF'])('accepts %s', (value) => {
    expect(HexSchema.parse(value)).toBe(value)
  })

  it.each([
    ['odd length', '0xabc'],
    ['missing prefix', 'abcd'],
    ['non-hex', '0xzz'],
    ['prefix only with odd digit', '0x1'],
  ])('rejects %s', (_label, value) => {
    expect(HexSchema.safeParse(value).success).toBe(false)
  })
})

describe('Hash32Schema', () => {
  it('accepts exactly 32 bytes', () => {
    const hash = '0x' + 'ab'.repeat(32)
    expect(Hash32Schema.parse(hash)).toBe(hash)
  })

  it.each([
    ['31 bytes', '0x' + 'ab'.repeat(31)],
    ['33 bytes', '0x' + 'ab'.repeat(33)],
    ['empty hex', '0x'],
  ])('rejects %s', (_label, value) => {
    expect(Hash32Schema.safeParse(value).success).toBe(false)
  })
})

describe('QuantitySchema', () => {
  it('parses a hex quantity to bigint', () => {
    expect(QuantitySchema.parse('0x2540be400')).toBe(10_000_000_000n)
  })

  it('accepts zero', () => {
    expect(QuantitySchema.parse('0x0')).toBe(0n)
  })

  it('tolerates leading zeros, which real nodes emit', () => {
    expect(QuantitySchema.parse('0x00ff')).toBe(255n)
  })

  it('accepts the uint256 maximum', () => {
    const max = '0x' + 'f'.repeat(64)
    expect(QuantitySchema.parse(max)).toBe((1n << 256n) - 1n)
  })

  /**
   * Beyond uint256 means a malfunctioning node or an attempt to overflow
   * something downstream. Either way it must not enter fee arithmetic.
   */
  it('rejects a value beyond uint256', () => {
    expect(QuantitySchema.safeParse('0x' + 'f'.repeat(65)).success).toBe(false)
  })

  it.each([
    ['negative', '-0x1'],
    ['decimal string', '1000'],
    ['missing prefix', 'ff'],
    ['empty hex', '0x'],
    ['non-hex', '0xnope'],
  ])('rejects %s', (_label, value) => {
    expect(QuantitySchema.safeParse(value).success).toBe(false)
  })
})

describe('ChainIdSchema', () => {
  it('accepts a normal chain id', () => {
    expect(ChainIdSchema.parse(84532)).toBe(84532)
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['beyond safe integer', Number.MAX_SAFE_INTEGER + 2],
  ])('rejects %s', (_label, value) => {
    expect(ChainIdSchema.safeParse(value).success).toBe(false)
  })
})
