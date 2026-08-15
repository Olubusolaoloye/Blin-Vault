import { z } from 'zod'
import { AddressSchema, type Address } from './primitives.js'

/**
 * Parsing of payment requests arriving from deep links and QR codes.
 *
 * These are the most hostile inputs the app accepts: an attacker fully controls
 * the bytes, and the user's mental model is "I scanned the code on the screen
 * in front of me". Two rules follow, and both are structural rather than
 * advisory.
 *
 * 1. NOTHING HERE EXECUTES ANYTHING. This module returns a `PaymentRequest`,
 *    which is a *proposal*. It must be turned into a TransferIntent and taken
 *    through the confirmation screen like any other transfer, so the address
 *    and amount are on screen before a biometric prompt (Invariant 8). There is
 *    deliberately no path from a scanned code to a signature.
 * 2. ANYTHING NOT UNDERSTOOD IS REJECTED, never ignored. A URI carrying a
 *    contract call, an unknown parameter, or a second address is refused
 *    outright rather than partially honoured — silently dropping the part we
 *    did not understand is how a "send 1 ETH" screen ends up authorising
 *    something else.
 *
 * Format is EIP-681: `ethereum:<address>[@<chainId>][?<params>]`.
 */

const MAX_UINT256 = (1n << 256n) - 1n

/** Guards against a pathological input like `1e999999999` costing real work. */
const MAX_EXPONENT = 78

export interface PaymentRequest {
  readonly to: Address
  /** null when the URI did not name a chain; the caller decides. */
  readonly chainId: number | null
  /** null when no amount was requested; the user enters one. */
  readonly amount: bigint | null
}

export class InvalidPaymentUriError extends Error {
  override readonly name = 'InvalidPaymentUriError'
}

/**
 * Parse an EIP-681 decimal amount to an exact bigint.
 *
 * WHY NOT Number(): EIP-681 permits scientific notation, and amounts are in wei.
 * `Number('2.014e18')` cannot be trusted — doubles hold only ~2^53 integers
 * exactly, so any wei amount above ~9e15 risks being silently rounded. A
 * rounded amount is a transfer of the wrong size that still looks plausible on
 * screen. All arithmetic here is therefore string and bigint only.
 *
 * Rejects anything that would imply a fractional smallest-unit value, since
 * that cannot be what the sender meant and rounding it is our decision to make,
 * not one to make silently.
 */
export function parseExactAmount(raw: string): bigint {
  if (!/^\d+(\.\d+)?([eE]\d+)?$/u.test(raw)) {
    throw new InvalidPaymentUriError(`Amount "${raw}" is not a positive decimal value.`)
  }

  const [mantissa = '', exponentPart] = raw.split(/[eE]/u)
  const exponent = exponentPart === undefined ? 0 : Number(exponentPart)

  if (exponent > MAX_EXPONENT) {
    throw new InvalidPaymentUriError('Amount exponent is out of range.')
  }

  const [integerPart = '', fractionPart = ''] = mantissa.split('.')
  const shift = exponent - fractionPart.length

  if (shift < 0) {
    throw new InvalidPaymentUriError(
      `Amount "${raw}" is not a whole number of the smallest unit.`,
    )
  }

  const digits = `${integerPart}${fractionPart}`.replace(/^0+(?=\d)/u, '')
  const value = BigInt(digits) * 10n ** BigInt(shift)

  if (value > MAX_UINT256) {
    throw new InvalidPaymentUriError('Amount exceeds uint256.')
  }

  return value
}

const ChainIdFromStringSchema = z
  .string()
  .regex(/^\d+$/u, 'Chain id must be a positive integer.')
  .transform((value) => Number(value))
  .refine((value) => value > 0 && value <= Number.MAX_SAFE_INTEGER, {
    message: 'Chain id is out of range.',
  })

/**
 * Parse a scanned or deep-linked payment request.
 *
 * Accepts a bare address (the common QR case) or an EIP-681 `ethereum:` URI.
 * Everything else is refused.
 */
export function parsePaymentUri(input: string): PaymentRequest {
  const trimmed = input.trim()
  if (trimmed === '') throw new InvalidPaymentUriError('Empty payment request.')

  // A bare address is the most common QR payload.
  const bare = AddressSchema.safeParse(trimmed)
  if (bare.success) return { to: bare.data, chainId: null, amount: null }

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/su.exec(trimmed)
  if (schemeMatch === null) {
    throw new InvalidPaymentUriError('Not an address or a payment URI.')
  }

  const [, scheme = '', remainder = ''] = schemeMatch
  if (scheme.toLowerCase() !== 'ethereum') {
    throw new InvalidPaymentUriError(`Unsupported scheme "${scheme}".`)
  }

  const [target = '', query] = remainder.split('?')

  /* A "/" introduces a function call — `ethereum:0x…/transfer?address=…`.
     Phase 1 sends value transfers only. Refusing outright is the point: a
     contract call reached through a scanned code is precisely the payload we
     must never execute on the user's behalf. */
  if (target.includes('/')) {
    throw new InvalidPaymentUriError('Contract calls from scanned codes are not supported.')
  }

  // `pay-` is a legacy EIP-681 prefix and carries no additional meaning here.
  const withoutPrefix = target.startsWith('pay-') ? target.slice(4) : target

  const [addressPart = '', chainPart, ...extraChainParts] = withoutPrefix.split('@')
  if (extraChainParts.length > 0) {
    throw new InvalidPaymentUriError('Malformed payment URI.')
  }

  const address = AddressSchema.safeParse(addressPart)
  if (!address.success) {
    throw new InvalidPaymentUriError('Payment URI does not contain a valid address.')
  }

  let chainId: number | null = null
  if (chainPart !== undefined) {
    const parsed = ChainIdFromStringSchema.safeParse(chainPart)
    if (!parsed.success) throw new InvalidPaymentUriError('Payment URI has an invalid chain id.')
    chainId = parsed.data
  }

  let amount: bigint | null = null
  if (query !== undefined && query !== '') {
    amount = parseAmountFromQuery(query)
  }

  return { to: address.data, chainId, amount }
}

/**
 * Extract the requested amount, refusing any parameter we do not understand.
 *
 * Unknown parameters are an error rather than something to skip: EIP-681 can
 * carry `gas`, `gasPrice`, `function`, and arbitrary typed arguments, and
 * honouring the address while quietly discarding the rest would present the
 * user a confirmation that does not describe the request they scanned.
 */
function parseAmountFromQuery(query: string): bigint | null {
  const params = new URLSearchParams(query)
  let amount: bigint | null = null

  for (const [key, value] of params) {
    if (key !== 'value') {
      throw new InvalidPaymentUriError(`Unsupported payment parameter "${key}".`)
    }
    if (amount !== null) {
      throw new InvalidPaymentUriError('Payment URI specifies more than one amount.')
    }
    amount = parseExactAmount(value)
  }

  return amount
}
