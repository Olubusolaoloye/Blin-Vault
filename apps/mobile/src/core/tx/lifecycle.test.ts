import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import { BundlerResponseError, parseUserOperationReceipt } from './bundler.js'
import {
  assertRecordSafeToPersist,
  canStartNewTransfer,
  LifecycleError,
  resolvePendingOperation,
  SUBMISSION_TIMEOUT_SECONDS,
  toRecoveryRecord,
  type RecoveryRecord,
} from './lifecycle.js'

const SENDER = getAddress('0x6c8b714529b0fe3920152432ac6e7d85f5b6e7a2')
const USER_OP_HASH = `0x${'ab'.repeat(32)}`
const SUBMITTED_AT = 1_800_000_000

const RECORD: RecoveryRecord = toRecoveryRecord({
  userOpHash: USER_OP_HASH,
  sender: SENDER,
  chainId: 84532,
  submittedAtSeconds: SUBMITTED_AT,
})

function receipt(overrides: Record<string, unknown> = {}) {
  return parseUserOperationReceipt({
    userOpHash: USER_OP_HASH,
    sender: SENDER,
    nonce: '0x1',
    actualGasCost: '0x2540be400',
    actualGasUsed: '0x5208',
    success: true,
    ...overrides,
  })
}

describe('toRecoveryRecord', () => {
  it('keeps the fields needed to recover an in-flight operation', () => {
    expect(RECORD).toEqual({
      userOpHash: USER_OP_HASH,
      sender: SENDER,
      chainId: 84532,
      submittedAtSeconds: SUBMITTED_AT,
    })
  })

  /**
   * Invariant 6. Everything persisted here is public and has already been given
   * to a third-party bundler. The test asks the question that should be asked
   * of any new field: would this still be safe on a stolen, unlocked device?
   */
  it('strips anything beyond the minimal public identifiers', () => {
    const record = toRecoveryRecord({
      userOpHash: USER_OP_HASH,
      sender: SENDER,
      chainId: 84532,
      submittedAtSeconds: SUBMITTED_AT,
      note: 'harmless looking extra',
    })

    expect(Object.keys(record).sort()).toEqual([
      'chainId',
      'sender',
      'submittedAtSeconds',
      'userOpHash',
    ])
  })

  it.each([
    ['a malformed hash', { userOpHash: '0xabc' }],
    ['a bad sender', { sender: '0xnope' }],
    ['a negative timestamp', { submittedAtSeconds: -1 }],
    ['a fractional timestamp', { submittedAtSeconds: 1.5 }],
    ['a zero chain id', { chainId: 0 }],
  ])('refuses to persist %s', (_label, override) => {
    expect(() => {
      toRecoveryRecord({
        userOpHash: USER_OP_HASH,
        sender: SENDER,
        chainId: 84532,
        submittedAtSeconds: SUBMITTED_AT,
        ...override,
      })
    }).toThrow(LifecycleError)
  })
})

describe('assertRecordSafeToPersist', () => {
  it('accepts a minimal record', () => {
    expect(() => {
      assertRecordSafeToPersist(RECORD)
    }).not.toThrow()
  })

  /**
   * The failure this catches is invisible when it happens: a signature quietly
   * reaching disk. Worth an explicit assertion rather than trusting that every
   * future caller goes through the schema.
   */
  it.each(['signature', 'privateKey', 'sessionKey', 'callData', 'userOperation', 'email', 'proof'])(
    'refuses a record carrying %s',
    (key) => {
      expect(() => {
        assertRecordSafeToPersist({ ...RECORD, [key]: 'anything' })
      }).toThrow(LifecycleError)
    },
  )
})

describe('resolvePendingOperation', () => {
  it('settles when a matching receipt arrives', () => {
    const resolution = resolvePendingOperation({
      record: RECORD,
      receipt: receipt(),
      nowSeconds: SUBMITTED_AT + 5,
    })

    expect(resolution).toEqual({
      action: 'settled',
      outcome: { status: 'succeeded', gasCost: 10_000_000_000n },
    })
  })

  it('settles a reverted operation as reverted rather than failed-to-send', () => {
    const resolution = resolvePendingOperation({
      record: RECORD,
      receipt: receipt({ success: false, reason: 'AA23 reverted' }),
      nowSeconds: SUBMITTED_AT + 5,
    })

    expect(resolution).toMatchObject({ action: 'settled', outcome: { status: 'reverted' } })
  })

  /** Invariant 7: a receipt is a bundler's claim until checked against ours. */
  it('rejects a receipt describing a different operation', () => {
    expect(() => {
      resolvePendingOperation({
        record: RECORD,
        receipt: receipt({ userOpHash: `0x${'cd'.repeat(32)}` }),
        nowSeconds: SUBMITTED_AT + 5,
      })
    }).toThrow(BundlerResponseError)
  })

  it('keeps waiting while inside the timeout', () => {
    expect(
      resolvePendingOperation({ record: RECORD, receipt: null, nowSeconds: SUBMITTED_AT + 30 }),
    ).toEqual({ action: 'still-pending', waitedSeconds: 30 })
  })

  it('escalates to the user once the timeout passes', () => {
    expect(
      resolvePendingOperation({
        record: RECORD,
        receipt: null,
        nowSeconds: SUBMITTED_AT + SUBMISSION_TIMEOUT_SECONDS,
      }),
    ).toEqual({ action: 'needs-user-decision', reason: 'timed-out' })
  })

  /**
   * The central rule. Resubmitting a stuck operation is a double-spend waiting
   * to happen: the app cannot tell "the bundler dropped it" from "the bundler
   * has it and is slow", and if the original lands after a replacement the user
   * has sent twice. There is deliberately no resubmit variant to return.
   */
  it('never resolves to an automatic resubmission, however long it waits', () => {
    for (const elapsed of [0, 60, SUBMISSION_TIMEOUT_SECONDS, 86_400, 86_400 * 30]) {
      const resolution = resolvePendingOperation({
        record: RECORD,
        receipt: null,
        nowSeconds: SUBMITTED_AT + elapsed,
      })

      expect(['still-pending', 'needs-user-decision']).toContain(resolution.action)
    }
  })

  /**
   * Clock skew, from the other direction: a device clock corrected backwards
   * must not restart the timeout, leaving the user watching a spinner for
   * another full window.
   */
  it('treats a backwards clock as no time having passed', () => {
    expect(
      resolvePendingOperation({ record: RECORD, receipt: null, nowSeconds: SUBMITTED_AT - 10_000 }),
    ).toEqual({ action: 'still-pending', waitedSeconds: 0 })
  })
})

describe('canStartNewTransfer', () => {
  it('allows a transfer when nothing is in flight', () => {
    expect(canStartNewTransfer([])).toBe(true)
  })

  /**
   * Two operations in flight from one account race on the nonce, and the loser
   * fails after the user already approved it. Refusing up front is easier to
   * explain than a failure arriving later with no obvious cause.
   */
  it('blocks a second transfer while one is unresolved', () => {
    expect(canStartNewTransfer([RECORD])).toBe(false)
  })
})
