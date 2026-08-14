import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import {
  assertGasEstimateSane,
  assertReceiptMatches,
  BundlerResponseError,
  classifyReceipt,
  parseGasEstimate,
  parseUserOperationReceipt,
  totalGasLimit,
} from './bundler.js'

const SENDER = getAddress('0x6c8b714529b0fe3920152432ac6e7d85f5b6e7a2')
const OTHER = getAddress('0x799318de96e2ccb47fd2e61aaf61a3951c3d338e')
const USER_OP_HASH = `0x${'ab'.repeat(32)}`
const OTHER_HASH = `0x${'cd'.repeat(32)}`

const RECEIPT_PAYLOAD = {
  userOpHash: USER_OP_HASH,
  sender: SENDER,
  nonce: '0x1',
  actualGasCost: '0x2540be400',
  actualGasUsed: '0x5208',
  success: true,
}

const ESTIMATE_PAYLOAD = {
  preVerificationGas: '0xc350', // 50_000
  verificationGasLimit: '0x186a0', // 100_000
  callGasLimit: '0x9c40', // 40_000
}

describe('parseGasEstimate', () => {
  it('parses hex quantities to bigint', () => {
    const estimate = parseGasEstimate(ESTIMATE_PAYLOAD)
    expect(estimate.preVerificationGas).toBe(50_000n)
    expect(estimate.verificationGasLimit).toBe(100_000n)
    expect(estimate.callGasLimit).toBe(40_000n)
  })

  it('accepts optional paymaster fields', () => {
    const estimate = parseGasEstimate({
      ...ESTIMATE_PAYLOAD,
      paymasterVerificationGasLimit: '0x2710',
      paymasterPostOpGasLimit: '0x1388',
    })
    expect(estimate.paymasterVerificationGasLimit).toBe(10_000n)
    expect(estimate.paymasterPostOpGasLimit).toBe(5_000n)
  })

  /**
   * Bundlers legitimately add vendor extensions. Rejecting them would couple us
   * to one provider, which is the coupling Invariant 7 exists to prevent.
   */
  it('ignores unknown vendor fields rather than failing', () => {
    expect(() =>
      parseGasEstimate({ ...ESTIMATE_PAYLOAD, pimlicoSpecificThing: 'whatever' }),
    ).not.toThrow()
  })

  it.each([
    ['a missing required field', { preVerificationGas: '0x1', callGasLimit: '0x1' }],
    ['a decimal number instead of hex', { ...ESTIMATE_PAYLOAD, callGasLimit: 40000 }],
    ['a null field', { ...ESTIMATE_PAYLOAD, callGasLimit: null }],
    ['a non-hex string', { ...ESTIMATE_PAYLOAD, callGasLimit: 'lots' }],
    ['a value beyond uint256', { ...ESTIMATE_PAYLOAD, callGasLimit: `0x${'f'.repeat(65)}` }],
    ['an array', []],
    ['null', null],
    ['a string', 'ok'],
  ])('rejects %s', (_label, payload) => {
    expect(() => parseGasEstimate(payload)).toThrow(BundlerResponseError)
  })
})

describe('totalGasLimit', () => {
  it('sums every phase', () => {
    expect(totalGasLimit(parseGasEstimate(ESTIMATE_PAYLOAD))).toBe(190_000n)
  })

  it('includes paymaster phases when present', () => {
    const estimate = parseGasEstimate({
      ...ESTIMATE_PAYLOAD,
      paymasterVerificationGasLimit: '0x2710',
      paymasterPostOpGasLimit: '0x1388',
    })
    expect(totalGasLimit(estimate)).toBe(205_000n)
  })

  it('stays exact at magnitudes a JS number could not hold', () => {
    const big = `0x${(10n ** 20n).toString(16)}`
    const estimate = parseGasEstimate({
      preVerificationGas: big,
      verificationGasLimit: '0x0',
      callGasLimit: '0x0',
    })
    expect(totalGasLimit(estimate)).toBe(10n ** 20n)
  })
})

describe('assertGasEstimateSane', () => {
  it('accepts a quote within the ceiling', () => {
    expect(() => {
      assertGasEstimateSane(parseGasEstimate(ESTIMATE_PAYLOAD), 200_000n)
    }).not.toThrow()
  })

  it('accepts a quote exactly at the ceiling', () => {
    expect(() => {
      assertGasEstimateSane(parseGasEstimate(ESTIMATE_PAYLOAD), 190_000n)
    }).not.toThrow()
  })

  /**
   * A bundler cannot forge a signature, but it can quote an inflated limit that
   * the user then signs over. "The user should have noticed the fee" is not a
   * control.
   */
  it('rejects an inflated quote', () => {
    const inflated = parseGasEstimate({ ...ESTIMATE_PAYLOAD, callGasLimit: `0x${(10n ** 12n).toString(16)}` })
    expect(() => {
      assertGasEstimateSane(inflated, 500_000n)
    }).toThrow(BundlerResponseError)
  })

  it('rejects a nonsensical ceiling rather than trusting it', () => {
    expect(() => {
      assertGasEstimateSane(parseGasEstimate(ESTIMATE_PAYLOAD), 0n)
    }).toThrow(BundlerResponseError)
  })
})

describe('parseUserOperationReceipt', () => {
  it('parses a well-formed receipt', () => {
    const receipt = parseUserOperationReceipt(RECEIPT_PAYLOAD)
    expect(receipt.userOpHash).toBe(USER_OP_HASH)
    expect(receipt.sender).toBe(SENDER)
    expect(receipt.actualGasCost).toBe(10_000_000_000n)
    expect(receipt.success).toBe(true)
  })

  it.each([
    ['a truncated hash', { ...RECEIPT_PAYLOAD, userOpHash: '0xabcd' }],
    ['a success flag that is a string', { ...RECEIPT_PAYLOAD, success: 'true' }],
    ['a missing success flag', { userOpHash: USER_OP_HASH, sender: SENDER, nonce: '0x1', actualGasCost: '0x1', actualGasUsed: '0x1' }],
    ['an invalid sender', { ...RECEIPT_PAYLOAD, sender: '0xnope' }],
    ['null', null],
    ['an empty object', {}],
  ])('rejects %s', (_label, payload) => {
    expect(() => parseUserOperationReceipt(payload)).toThrow(BundlerResponseError)
  })
})

describe('assertReceiptMatches — Invariant 7 in practice', () => {
  const receipt = parseUserOperationReceipt(RECEIPT_PAYLOAD)

  it('accepts a receipt for the operation we submitted', () => {
    expect(() => {
      assertReceiptMatches(receipt, { userOpHash: USER_OP_HASH, sender: SENDER })
    }).not.toThrow()
  })

  it('tolerates casing differences in the compared values', () => {
    expect(() => {
      assertReceiptMatches(receipt, {
        userOpHash: USER_OP_HASH.toUpperCase().replace('0X', '0x'),
        sender: SENDER.toLowerCase(),
      })
    }).not.toThrow()
  })

  /**
   * The failure this exists to catch: a bundler returning a perfectly valid,
   * perfectly successful receipt belonging to some *other* operation. Without
   * this check the app reports "sent" for something the user never authorised.
   */
  it('rejects a plausible receipt for a different operation', () => {
    expect(() => {
      assertReceiptMatches(receipt, { userOpHash: OTHER_HASH, sender: SENDER })
    }).toThrow(BundlerResponseError)
  })

  it('rejects a receipt for a different account', () => {
    expect(() => {
      assertReceiptMatches(receipt, { userOpHash: USER_OP_HASH, sender: OTHER })
    }).toThrow(BundlerResponseError)
  })
})

describe('classifyReceipt', () => {
  it('reports a successful operation', () => {
    expect(classifyReceipt(parseUserOperationReceipt(RECEIPT_PAYLOAD))).toEqual({
      status: 'succeeded',
      gasCost: 10_000_000_000n,
    })
  })

  /**
   * An operation can be included on-chain and still revert: mined, gas charged,
   * nothing moved. Reporting that as a completed transfer would be the most
   * misleading thing this app could do.
   */
  it('reports a reverted operation as reverted, not sent', () => {
    const reverted = parseUserOperationReceipt({
      ...RECEIPT_PAYLOAD,
      success: false,
      reason: 'AA23 reverted',
    })

    expect(classifyReceipt(reverted)).toEqual({
      status: 'reverted',
      gasCost: 10_000_000_000n,
      reason: 'AA23 reverted',
    })
  })

  it('still charges gas on a revert, which the user must be told about', () => {
    const reverted = parseUserOperationReceipt({ ...RECEIPT_PAYLOAD, success: false })
    const outcome = classifyReceipt(reverted)
    expect(outcome.gasCost).toBeGreaterThan(0n)
  })

  it('normalises a missing revert reason to null rather than undefined', () => {
    const reverted = parseUserOperationReceipt({ ...RECEIPT_PAYLOAD, success: false })
    expect(classifyReceipt(reverted)).toMatchObject({ status: 'reverted', reason: null })
  })
})
