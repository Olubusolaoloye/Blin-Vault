import { describe, expect, it, vi } from 'vitest'
import { P256 } from 'ox'
import { size, type Address, type Hex } from 'viem'
import {
  detectP256Strategy,
  P256CapabilityCache,
  P256ProbeError,
  P256_PRECOMPILE_ADDRESS,
  P256_PROBE_CALLDATA,
  P256_PROBE_VECTOR,
  P256_VALID_OUTPUT,
  P256_VERIFICATION_GAS,
  type EthCaller,
} from './p256.js'

/** A caller that returns a fixed response, standing in for one chain's RPC. */
function callerReturning(data: Hex | undefined): EthCaller {
  const call = vi.fn(() => Promise.resolve({ data }))
  return { call }
}

/** A caller whose transport fails, standing in for a network blip. */
function callerFailing(cause: Error): EthCaller {
  const call = vi.fn(() => Promise.reject(cause))
  return { call }
}

describe('probe vector', () => {
  it('is a genuinely valid P-256 signature', () => {
    // If this fails, the constant has been corrupted and every probe would
    // silently classify every chain as lacking the precompile.
    const valid = P256.verify({
      publicKey: { x: P256_PROBE_VECTOR.x, y: P256_PROBE_VECTOR.y, prefix: 4 },
      payload: P256_PROBE_VECTOR.hash,
      signature: { r: P256_PROBE_VECTOR.r, s: P256_PROBE_VECTOR.s },
    })
    expect(valid).toBe(true)
  })

  it('encodes to exactly 160 bytes as both precompiles require', () => {
    expect(size(P256_PROBE_CALLDATA)).toBe(160)
  })
})

describe('detectP256Strategy', () => {
  it('reports precompile when 0x100 affirmatively returns 1', async () => {
    await expect(detectP256Strategy(callerReturning(P256_VALID_OUTPUT))).resolves.toBe('precompile')
  })

  it('probes the shared precompile address with the 160-byte vector', async () => {
    const call = vi.fn(() => Promise.resolve({ data: P256_VALID_OUTPUT }))
    await detectP256Strategy({ call })
    expect(call).toHaveBeenCalledWith({
      to: P256_PRECOMPILE_ADDRESS,
      data: P256_PROBE_CALLDATA,
    })
  })

  it('accepts the valid output regardless of hex casing', async () => {
    const upper = ('0x' + P256_VALID_OUTPUT.slice(2).toUpperCase()) as Hex
    await expect(detectP256Strategy(callerReturning(upper))).resolves.toBe('precompile')
  })

  /**
   * THE TRAP. On a chain with no precompile, 0x100 is an empty account and the
   * call succeeds returning nothing — indistinguishable from RIP-7212 reporting
   * an invalid signature. Both must classify as fallback. A verifier that read
   * either of these as success would accept forged signatures.
   */
  it.each<[string, Hex | undefined]>([
    ['undefined returndata (viem empty-account shape)', undefined],
    ['0x empty returndata', '0x'],
  ])('classifies %s as fallback, never as a valid signature', async (_label, data) => {
    await expect(detectP256Strategy(callerReturning(data))).resolves.toBe('solidity-fallback')
  })

  it('classifies a 32-byte zero response as fallback', async () => {
    const zero = ('0x' + '00'.repeat(32)) as Hex
    await expect(detectP256Strategy(callerReturning(zero))).resolves.toBe('solidity-fallback')
  })

  it('classifies truncated or oversized responses as fallback', async () => {
    await expect(detectP256Strategy(callerReturning('0x01'))).resolves.toBe('solidity-fallback')
    await expect(
      detectP256Strategy(callerReturning(('0x' + '00'.repeat(31) + '0101') as Hex)),
    ).resolves.toBe('solidity-fallback')
  })

  /**
   * A transport failure is not evidence of absence. Classifying it as fallback
   * would pin the chain to the 330k-gas path on a transient network blip.
   */
  it('throws rather than classifying when the RPC itself fails', async () => {
    await expect(detectP256Strategy(callerFailing(new Error('ECONNRESET')))).rejects.toBeInstanceOf(
      P256ProbeError,
    )
  })

  it('preserves the underlying transport failure as the error cause', async () => {
    const cause = new Error('ECONNRESET')
    await expect(detectP256Strategy(callerFailing(cause))).rejects.toMatchObject({ cause })
  })
})

describe('P256CapabilityCache', () => {
  const BASE_SEPOLIA = 84532

  it('probes once per chain and reuses the result', async () => {
    const cache = new P256CapabilityCache()
    const call = vi.fn(() => Promise.resolve({ data: P256_VALID_OUTPUT }))

    await expect(cache.get(BASE_SEPOLIA, { call })).resolves.toBe('precompile')
    await expect(cache.get(BASE_SEPOLIA, { call })).resolves.toBe('precompile')

    expect(call).toHaveBeenCalledOnce()
  })

  it('keeps chains independent', async () => {
    const cache = new P256CapabilityCache()

    await cache.get(BASE_SEPOLIA, callerReturning(P256_VALID_OUTPUT))
    await cache.get(31337, callerReturning(undefined))

    expect(cache.peek(BASE_SEPOLIA)).toBe('precompile')
    expect(cache.peek(31337)).toBe('solidity-fallback')
  })

  it('does not cache a failed probe, so a blip cannot pin the expensive path', async () => {
    const cache = new P256CapabilityCache()

    await expect(cache.get(BASE_SEPOLIA, callerFailing(new Error('timeout')))).rejects.toBeInstanceOf(
      P256ProbeError,
    )
    expect(cache.peek(BASE_SEPOLIA)).toBeUndefined()

    await expect(cache.get(BASE_SEPOLIA, callerReturning(P256_VALID_OUTPUT))).resolves.toBe(
      'precompile',
    )
  })
})

describe('gas budgeting', () => {
  it('budgets the conservative EIP-7951 cost for any precompile', () => {
    // Deliberately 6900 rather than RIP-7212's 3450: under-estimating fails a
    // transaction the user already approved, over-estimating costs a rounding
    // error on an L2.
    expect(P256_VERIFICATION_GAS.precompile).toBe(6_900n)
  })

  it('budgets substantially more for the Solidity fallback', () => {
    expect(P256_VERIFICATION_GAS['solidity-fallback']).toBeGreaterThan(
      P256_VERIFICATION_GAS.precompile * 10n,
    )
  })
})

describe('module surface', () => {
  it('targets the address shared by RIP-7212 and EIP-7951', () => {
    const expected: Address = '0x0000000000000000000000000000000000000100'
    expect(P256_PRECOMPILE_ADDRESS).toBe(expected)
  })
})
