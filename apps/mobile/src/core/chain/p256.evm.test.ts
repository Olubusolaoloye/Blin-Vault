import { describe, expect, it } from 'vitest'
import { createEVM, type EVM } from '@ethereumjs/evm'
import { Common, Hardfork, Mainnet } from '@ethereumjs/common'
import { createAddressFromString } from '@ethereumjs/util'
import { bytesToHex, hexToBytes, type Address, type Hex } from 'viem'
import {
  detectP256Strategy,
  P256_PRECOMPILE_ADDRESS,
  P256_PROBE_CALLDATA,
  P256_PROBE_VECTOR,
  P256_VALID_OUTPUT,
  P256_VERIFICATION_GAS,
  type EthCaller,
} from './p256.js'

/**
 * The P-256 capability probe, exercised against a real EVM.
 *
 * The unit tests in p256.test.ts drive the probe with mocked responses, which
 * proves the classification logic but assumes the EVM behaviour those mocks
 * describe. This suite removes that assumption: it runs the same probe against
 * an actual EVM implementation on two hardforks, one with the EIP-7951
 * precompile at 0x100 (Osaka, shipped as Fusaka) and one without (Prague).
 *
 * It exists because the security argument in p256.ts rests on a claim about EVM
 * semantics — that a CALL to an empty account succeeds and returns nothing —
 * and a claim like that should be demonstrated rather than asserted.
 *
 * This does not replace verification against Base Sepolia and a deployed
 * account; it establishes that the probe is correct about the EVM itself.
 */

const PRECOMPILE = createAddressFromString(P256_PRECOMPILE_ADDRESS)

async function evmForHardfork(hardfork: Hardfork): Promise<EVM> {
  return createEVM({ common: new Common({ chain: Mainnet, hardfork }) })
}

/** Adapts the EVM to the same narrow interface a viem PublicClient satisfies. */
function callerFor(evm: EVM): EthCaller {
  return {
    async call({ to, data }: { to: Address; data: Hex }) {
      const result = await evm.runCall({
        to: createAddressFromString(to),
        data: hexToBytes(data),
        gasLimit: 1_000_000n,
      })
      const returned = result.execResult.returnValue
      // viem surfaces empty returndata as undefined; the mock suite covers the
      // '0x' spelling as well.
      return { data: returned.length === 0 ? undefined : bytesToHex(returned) }
    },
  }
}

/** The probe vector with a single byte of r corrupted — a well-formed but invalid signature. */
const INVALID_CALLDATA: Hex = (P256_PROBE_CALLDATA.slice(0, 66) +
  (P256_PROBE_VECTOR.r.slice(2, 4) === 'ff' ? 'ee' : 'ff') +
  P256_PROBE_CALLDATA.slice(68)) as Hex

describe('EVM ground truth', () => {
  /**
   * THE TRAP, demonstrated rather than asserted.
   *
   * On a chain without the precompile, 0x100 is an ordinary empty account. The
   * CALL does not revert — it succeeds, returns nothing, and costs no gas. That
   * is byte-for-byte what RIP-7212 returns when a signature is INVALID.
   *
   * A verifier that treated "the call succeeded" as "the signature is valid"
   * would therefore accept every forged signature on every chain lacking the
   * precompile.
   */
  it('a call to 0x100 without the precompile succeeds and returns nothing', async () => {
    const evm = await evmForHardfork(Hardfork.Prague)
    const result = await evm.runCall({
      to: PRECOMPILE,
      data: hexToBytes(P256_PROBE_CALLDATA),
      gasLimit: 1_000_000n,
    })

    expect(result.execResult.exceptionError).toBeUndefined()
    expect(result.execResult.returnValue.length).toBe(0)
    expect(result.execResult.executionGasUsed).toBe(0n)
  })

  it('the same call with the precompile returns an affirmative 1', async () => {
    const evm = await evmForHardfork(Hardfork.Osaka)
    const result = await evm.runCall({
      to: PRECOMPILE,
      data: hexToBytes(P256_PROBE_CALLDATA),
      gasLimit: 1_000_000n,
    })

    expect(bytesToHex(result.execResult.returnValue)).toBe(P256_VALID_OUTPUT)
  })

  /**
   * The other half of the ambiguity: with the precompile present, an INVALID
   * signature also produces empty returndata. Absent and invalid are genuinely
   * indistinguishable from the response alone, which is why the probe requires
   * a known-VALID signature to return 1 rather than inferring from a failure.
   */
  it('an invalid signature is indistinguishable from an absent precompile', async () => {
    // Still exactly 160 bytes, so this exercises signature rejection rather
    // than input-length rejection — which would prove nothing about the trap.
    expect(hexToBytes(INVALID_CALLDATA).length).toBe(160)
    expect(INVALID_CALLDATA).not.toBe(P256_PROBE_CALLDATA)

    const evm = await evmForHardfork(Hardfork.Osaka)
    const result = await evm.runCall({
      to: PRECOMPILE,
      data: hexToBytes(INVALID_CALLDATA),
      gasLimit: 1_000_000n,
    })

    expect(result.execResult.exceptionError).toBeUndefined()
    expect(result.execResult.returnValue.length).toBe(0)
  })

  /**
   * Pins the gas constant against a real implementation. If this fails, the fee
   * shown on the confirmation screen is wrong (Invariant 8).
   */
  it('charges exactly the EIP-7951 gas we budget for', async () => {
    const evm = await evmForHardfork(Hardfork.Osaka)
    const result = await evm.runCall({
      to: PRECOMPILE,
      data: hexToBytes(P256_PROBE_CALLDATA),
      gasLimit: 1_000_000n,
    })

    expect(result.execResult.executionGasUsed).toBe(P256_VERIFICATION_GAS.precompile)
    expect(result.execResult.executionGasUsed).toBe(6_900n)
  })
})

describe('detectP256Strategy against a real EVM', () => {
  it('reports the precompile present on a chain that has it', async () => {
    const evm = await evmForHardfork(Hardfork.Osaka)
    await expect(detectP256Strategy(callerFor(evm))).resolves.toBe('precompile')
  })

  /**
   * The classification that matters. A real EVM lacking the precompile must
   * drive the probe to the fallback verifier, never to "precompile present"
   * and never to "signature invalid".
   */
  it('falls back on a chain that lacks it', async () => {
    const evm = await evmForHardfork(Hardfork.Prague)
    await expect(detectP256Strategy(callerFor(evm))).resolves.toBe('solidity-fallback')
  })

  it('is stable across repeated probes on the same chain', async () => {
    const evm = await evmForHardfork(Hardfork.Prague)
    const caller = callerFor(evm)

    for (let i = 0; i < 3; i++) {
      await expect(detectP256Strategy(caller)).resolves.toBe('solidity-fallback')
    }
  })
})
