import { concat, type Address, type Hex } from 'viem'

/**
 * Detection of on-chain secp256r1 (P-256) verification capability.
 *
 * This module decides how a passkey signature will be verified on a given
 * chain. Getting it wrong is not a performance problem, it is a total
 * compromise — see WHY THIS IS BEHAVIOURAL, below.
 *
 * Background (ARCHITECTURE.md §3): there are three cases.
 *
 *   EIP-7951   address 0x100, 6900 gas — Ethereum mainnet since Fusaka (2025-12-03)
 *   RIP-7212   address 0x100, 3450 gas — Base, Optimism, Arbitrum, Polygon, zkSync
 *   neither    audited Solidity fallback verifier, ~300k gas
 *
 * Note that the two precompiles share an address and have identical input and
 * output encodings. They cannot be told apart by address.
 */

/** Both RIP-7212 and EIP-7951 live here. Shared address, different semantics. */
export const P256_PRECOMPILE_ADDRESS: Address = '0x0000000000000000000000000000000000000100'

/**
 * A known-good P-256 signature used to probe for precompile support.
 *
 * Generated with ox's P256 implementation and re-verified in this module's test
 * suite, so a corrupted constant fails CI rather than silently degrading every
 * probe to "precompile absent". There is no secret here — a signature and its
 * public key are public by nature.
 */
export const P256_PROBE_VECTOR = {
  hash: '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
  r: '0xff059258d3b6bd759953bf7b581a9f1b8d9dc84a630e1d79663c988c65be6f38',
  s: '0x25336fc1fe30cb0a7862a8136566c3db6fd1d36f85a5ac741321391882d2b543',
  x: '0x6c8b714529b0fe3920152432ac6e7d85f5b6e7a2717e07a01b82c1eea9bf4403',
  y: '0x799318de96e2ccb47fd2e61aaf61a3951c3d338ec569c8d8bb750f9e73b9ab41',
} as const satisfies Record<string, Hex>

/** 160 bytes: hash ‖ r ‖ s ‖ x ‖ y — identical for both precompiles. */
export const P256_PROBE_CALLDATA: Hex = concat([
  P256_PROBE_VECTOR.hash,
  P256_PROBE_VECTOR.r,
  P256_PROBE_VECTOR.s,
  P256_PROBE_VECTOR.x,
  P256_PROBE_VECTOR.y,
])

/** Both precompiles return 32-byte 1 on success, and *empty output* on failure. */
export const P256_VALID_OUTPUT: Hex = '0x0000000000000000000000000000000000000000000000000000000000000001'

export type P256Strategy = 'precompile' | 'solidity-fallback'

/**
 * Gas to budget for one P-256 verification.
 *
 * The precompile figure is deliberately the EIP-7951 cost (6900) rather than
 * the RIP-7212 cost (3450), even on chains that implement the cheaper one.
 *
 * WHY: for a *valid* signature the two precompiles are byte-for-byte
 * indistinguishable — same address, same input, same output — so telling them
 * apart would require probing with a constrained gas limit. The difference is
 * 3450 gas, which on an L2 is a rounding error, while an under-estimate
 * produces a failed transaction in front of a user who has already approved it.
 * Over-estimating is the safe direction, so we take it.
 */
export const P256_VERIFICATION_GAS: Record<P256Strategy, bigint> = {
  precompile: 6_900n,
  'solidity-fallback': 330_000n,
}

/** A probe could not reach a definitive answer. Never means "absent". */
export class P256ProbeError extends Error {
  override readonly name = 'P256ProbeError'
}

/** The narrow slice of a viem PublicClient this module needs. */
export interface EthCaller {
  call(args: { to: Address; data: Hex }): Promise<{ data?: Hex | undefined }>
}

/**
 * Determine how P-256 signatures must be verified on the caller's chain.
 *
 * WHY THIS IS BEHAVIOURAL RATHER THAN AN ADDRESS OR CHAIN-ID LOOKUP:
 *
 * On a chain with no precompile, 0x100 is an ordinary empty account. A CALL to
 * an empty account *succeeds and returns no data* — which is byte-identical to
 * what RIP-7212 returns when a signature is invalid. So:
 *
 *   - Reading "the call succeeded" as "the signature is valid" yields a
 *     verifier that accepts every forged signature on any chain lacking the
 *     precompile. Total compromise of Invariant 3 and of the passkey factor.
 *   - Reading "empty output" as "the precompile is missing" is merely wasteful,
 *     but it masks the bug above during testing.
 *
 * The only sound test is to send a signature we know to be valid and require
 * the precompile to affirmatively return 1. Anything else — empty output, a
 * revert, a short or malformed response — means we cannot rely on it.
 *
 * Ambiguity resolves toward 'solidity-fallback' because that direction is safe:
 * the fallback verifier is correct everywhere, just more expensive. The unsafe
 * direction is never taken automatically.
 *
 * @throws {P256ProbeError} if the RPC itself failed. A transport failure is not
 * evidence of absence, and must not be cached as though it were — the caller
 * should retry or surface an error rather than silently pay 330k gas forever.
 */
export async function detectP256Strategy(caller: EthCaller): Promise<P256Strategy> {
  let result: { data?: Hex | undefined }

  try {
    result = await caller.call({
      to: P256_PRECOMPILE_ADDRESS,
      data: P256_PROBE_CALLDATA,
    })
  } catch (cause) {
    throw new P256ProbeError(
      'P-256 capability probe failed at the transport layer; capability is unknown, not absent.',
      { cause },
    )
  }

  if (result.data === undefined) return 'solidity-fallback'

  return result.data.toLowerCase() === P256_VALID_OUTPUT ? 'precompile' : 'solidity-fallback'
}

/**
 * Per-chain cache of the probe result.
 *
 * Only definitive answers are cached. A P256ProbeError propagates and leaves
 * the cache untouched, so a transient RPC failure cannot pin a chain to the
 * expensive path for the lifetime of the process.
 */
export class P256CapabilityCache {
  readonly #byChainId = new Map<number, P256Strategy>()

  async get(chainId: number, caller: EthCaller): Promise<P256Strategy> {
    const cached = this.#byChainId.get(chainId)
    if (cached !== undefined) return cached

    const strategy = await detectP256Strategy(caller)
    this.#byChainId.set(chainId, strategy)
    return strategy
  }

  peek(chainId: number): P256Strategy | undefined {
    return this.#byChainId.get(chainId)
  }

  clear(): void {
    this.#byChainId.clear()
  }
}
