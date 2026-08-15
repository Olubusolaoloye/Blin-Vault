import { getAddress, isAddress } from 'viem'
import { z } from 'zod'

/**
 * Parsers for values arriving from outside the app: RPC responses, bundler
 * responses, deep links, QR payloads, stored preferences.
 *
 * Nothing from an external boundary reaches app logic without passing through
 * one of these (CLAUDE.md conventions). They are deliberately strict — a
 * rejected input surfaces an error the user can act on, whereas a leniently
 * coerced one becomes a transaction nobody intended.
 */

const MAX_UINT256 = (1n << 256n) - 1n

/**
 * A checksummed EVM address.
 *
 * WHY isAddress(strict) AND NOT getAddress ALONE:
 *
 * viem's `getAddress` validates *format* only. Handed a mixed-case address
 * whose EIP-55 checksum is wrong, it does not throw — it silently recomputes
 * the checksum and returns a well-formed address with the tampered nibble
 * intact. Verified against viem 2.55.16.
 *
 * The checksum is the one cheap integrity check available on an address that
 * arrived from a QR code, a deep link, or a pasted string, and it is exactly
 * the check that catches a single flipped character. So the checksum is
 * validated first, and only then is the value normalised.
 *
 * Accepted: all-lowercase (carries no checksum information, so nothing to
 * verify) and correctly checksummed mixed case.
 * Rejected: mixed case with a wrong checksum, and all-uppercase — neither is a
 * form we should silently trust.
 */
export const AddressSchema = z
  .string()
  .refine((value) => isAddress(value, { strict: true }), {
    message: 'Not a valid address, or its checksum does not match.',
  })
  .transform((value) => getAddress(value))

/** Arbitrary-length hex string with an even number of digits. */
export const HexSchema = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})*$/u, 'Expected an even-length 0x-prefixed hex string.')
  .transform((value) => value as `0x${string}`)

/** Exactly 32 bytes of hex — transaction hashes, UserOperation hashes, digests. */
export const Hash32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/u, 'Expected a 32-byte 0x-prefixed hex value.')
  .transform((value) => value as `0x${string}`)

/**
 * A JSON-RPC quantity: hex-encoded, unsigned, at most 32 bytes.
 *
 * Bounded at uint256 because an out-of-range value is either a malfunctioning
 * node or an attempt to overflow something downstream; either way it is not a
 * number we should carry into fee arithmetic.
 */
export const QuantitySchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/u, 'Expected a 0x-prefixed hex quantity.')
  .transform((value) => BigInt(value))
  .refine((value) => value <= MAX_UINT256, {
    message: 'Quantity exceeds uint256.',
  })

/**
 * A chain id as reported by an external source.
 *
 * Bounded to a safe integer: chain ids arrive as numbers in some payloads and
 * as hex in others, and a value beyond Number.MAX_SAFE_INTEGER silently loses
 * precision, which would let two different chains compare equal.
 */
export const ChainIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

export type Address = z.output<typeof AddressSchema>
export type Hex = z.output<typeof HexSchema>
export type Hash32 = z.output<typeof Hash32Schema>
