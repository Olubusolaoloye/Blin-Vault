import { describe, expect, it } from 'vitest'
import { AddressSchema } from './primitives.js'
import { InvalidPaymentUriError, parseExactAmount, parsePaymentUri } from './paymentUri.js'

const LOWER = '0x6c8b714529b0fe3920152432ac6e7d85f5b6e7a2'
const ADDRESS = AddressSchema.parse(LOWER)

describe('parseExactAmount', () => {
  it.each([
    ['plain integer', '1000', 1000n],
    ['zero', '0', 0n],
    ['scientific notation', '1e18', 10n ** 18n],
    ['fractional mantissa with exponent', '2.014e18', 2_014_000_000_000_000_000n],
    ['trailing zeros in mantissa', '1.500e3', 1500n],
    ['leading zeros', '007', 7n],
  ])('parses %s exactly', (_label, input, expected) => {
    expect(parseExactAmount(input)).toBe(expected)
  })

  /**
   * The precision trap. Doubles hold only ~2^53 integers exactly, so any wei
   * amount above roughly 9e15 can be silently rounded by Number(). A rounded
   * amount is a transfer of the wrong size that still looks plausible on screen.
   */
  it('stays exact where Number() would lose precision', () => {
    const input = '123456789012345678901'
    expect(parseExactAmount(input)).toBe(123456789012345678901n)
    expect(BigInt(Number(input))).not.toBe(123456789012345678901n)
  })

  it('keeps a large scientific value exact', () => {
    expect(parseExactAmount('9.007199254740993e18')).toBe(9_007_199_254_740_993_000n)
  })

  it.each([
    ['fractional wei', '1.5'],
    ['fraction beyond the exponent', '1.2345e2'],
    ['negative', '-1'],
    ['negative exponent', '1e-18'],
    ['hex', '0x10'],
    ['empty', ''],
    ['whitespace', ' 1 '],
    ['not a number', 'abc'],
    ['double exponent', '1e1e1'],
    ['bare decimal point', '.'],
  ])('rejects %s', (_label, input) => {
    expect(() => parseExactAmount(input)).toThrow(InvalidPaymentUriError)
  })

  it('rejects an absurd exponent rather than computing it', () => {
    expect(() => parseExactAmount('1e999999999')).toThrow(InvalidPaymentUriError)
  })

  it('rejects a value beyond uint256', () => {
    expect(() => parseExactAmount('1e78')).toThrow(InvalidPaymentUriError)
  })
})

describe('parsePaymentUri', () => {
  it('accepts a bare address, the common QR payload', () => {
    expect(parsePaymentUri(LOWER)).toEqual({ to: ADDRESS, chainId: null, amount: null })
  })

  it('trims surrounding whitespace from a scanned payload', () => {
    expect(parsePaymentUri(`  ${LOWER}\n`).to).toBe(ADDRESS)
  })

  it('parses an EIP-681 URI with chain and value', () => {
    expect(parsePaymentUri(`ethereum:${LOWER}@84532?value=1e18`)).toEqual({
      to: ADDRESS,
      chainId: 84532,
      amount: 10n ** 18n,
    })
  })

  it('parses without a chain id, leaving the choice to the caller', () => {
    expect(parsePaymentUri(`ethereum:${LOWER}?value=5`).chainId).toBeNull()
  })

  it('parses without an amount, leaving the user to enter one', () => {
    expect(parsePaymentUri(`ethereum:${LOWER}@84532`).amount).toBeNull()
  })

  it('accepts the legacy pay- prefix', () => {
    expect(parsePaymentUri(`ethereum:pay-${LOWER}@84532`).to).toBe(ADDRESS)
  })

  it('accepts a mixed-case scheme', () => {
    expect(parsePaymentUri(`ETHEREUM:${LOWER}`).to).toBe(ADDRESS)
  })

  it('normalises the address so comparisons do not depend on scanned casing', () => {
    expect(parsePaymentUri(`ethereum:${LOWER}`).to).toBe(parsePaymentUri(ADDRESS).to)
  })

  /**
   * A contract call reached through a scanned code is exactly the payload we
   * must never execute for the user. Refused rather than partially honoured.
   */
  it('refuses a contract call', () => {
    expect(() => parsePaymentUri(`ethereum:${LOWER}/transfer?address=${LOWER}&uint256=1`)).toThrow(
      InvalidPaymentUriError,
    )
  })

  /**
   * Silently dropping a parameter we did not understand would show the user a
   * confirmation that does not describe what they scanned.
   */
  it.each([
    ['gas', `ethereum:${LOWER}?gas=21000`],
    ['gasPrice', `ethereum:${LOWER}?value=1&gasPrice=100`],
    ['arbitrary', `ethereum:${LOWER}?anything=1`],
  ])('refuses an unsupported parameter: %s', (_label, uri) => {
    expect(() => parsePaymentUri(uri)).toThrow(InvalidPaymentUriError)
  })

  it('refuses a URI naming two amounts', () => {
    expect(() => parsePaymentUri(`ethereum:${LOWER}?value=1&value=2`)).toThrow(
      InvalidPaymentUriError,
    )
  })

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['unsupported scheme', `bitcoin:${LOWER}`],
    ['http scheme', `https://example.com/${LOWER}`],
    ['no scheme and not an address', 'just some text'],
    ['scheme with no address', 'ethereum:'],
    ['invalid address', 'ethereum:0x1234'],
    ['two chain separators', `ethereum:${LOWER}@1@2`],
    ['non-numeric chain id', `ethereum:${LOWER}@base`],
    ['zero chain id', `ethereum:${LOWER}@0`],
    ['bad amount', `ethereum:${LOWER}?value=abc`],
  ])('rejects %s', (_label, input) => {
    expect(() => parsePaymentUri(input)).toThrow(InvalidPaymentUriError)
  })

  /**
   * A tampered checksum is the signal that a displayed address was altered in
   * transit. It must not survive a scan.
   */
  it('rejects an address whose checksum was tampered with', () => {
    const tampered = ADDRESS.slice(0, -1) + (ADDRESS.endsWith('2') ? '3' : '2')
    expect(() => parsePaymentUri(`ethereum:${tampered}`)).toThrow(InvalidPaymentUriError)
  })

  it('returns a plain proposal with no capacity to execute anything', () => {
    const request = parsePaymentUri(`ethereum:${LOWER}@84532?value=1e18`)
    expect(Object.keys(request).sort()).toEqual(['amount', 'chainId', 'to'])
  })
})
