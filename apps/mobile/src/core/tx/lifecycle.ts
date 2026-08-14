import { z } from 'zod'
import { AddressSchema, ChainIdSchema, Hash32Schema } from '../validation/primitives.js'
import {
  assertReceiptMatches,
  classifyReceipt,
  type OperationOutcome,
  type UserOperationReceipt,
} from './bundler.js'

/**
 * What survives the app being killed mid-transaction.
 *
 * Two adversarial paths from PHASES.md Task 9 meet here — "app killed
 * mid-transaction" and "network drop mid-signature" — and they pull in opposite
 * directions. Recovering gracefully wants state written to disk; Invariant 6
 * says never persist a full UserOperation with its signature. The resolution is
 * that only ONE point in the lifecycle is both worth recovering and safe to
 * record.
 *
 *   drafted / awaiting signature  — nothing to recover. The user has authorised
 *       nothing, no operation exists on any network, and the only artifact
 *       worth keeping (a signature) is exactly what Invariant 6 forbids
 *       storing. Losing this state costs the user one re-entry.
 *
 *   submitted                     — recovery matters and is safe. The operation
 *       may already be in flight; the user must not be told it failed when it
 *       is about to succeed. What identifies it — the operation hash — is
 *       public, already handed to a third-party bundler, and useless to an
 *       attacker on its own.
 *
 *   settled                       — historical, no longer in flight.
 *
 * So the recovery record holds a hash and nothing else of consequence. No
 * signature, no calldata, no key material.
 */

/**
 * Everything the app may write to disk about an in-flight operation.
 *
 * Deliberately minimal. Every field here is public information that has already
 * been transmitted to a bundler. If a future change wants to add a field, the
 * question to answer first is whether it would still be safe on a stolen,
 * unlocked device.
 */
export const RecoveryRecordSchema = z.object({
  userOpHash: Hash32Schema,
  sender: AddressSchema,
  chainId: ChainIdSchema,
  submittedAtSeconds: z.number().int().nonnegative(),
})

export type RecoveryRecord = z.output<typeof RecoveryRecordSchema>

/**
 * How long a submitted operation may stay unresolved before the app stops
 * waiting silently and tells the user.
 *
 * This is not a retry timer — see resolvePendingOperation. It is the point at
 * which continuing to show a spinner becomes dishonest.
 */
export const SUBMISSION_TIMEOUT_SECONDS = 180

export class LifecycleError extends Error {
  override readonly name = 'LifecycleError'
}

/**
 * Guard against a recovery record carrying anything it should not.
 *
 * Invariant 6 is enforced by the schema stripping unknown keys, but a caller
 * can still hand a hand-built object to a storage layer. This is the assertion
 * that fails loudly rather than letting a signature reach disk — a check worth
 * having precisely because the failure is invisible when it happens.
 */
const FORBIDDEN_RECORD_KEYS = new Set([
  'signature',
  'privateKey',
  'sessionKey',
  'callData',
  'userOperation',
  'email',
  'proof',
])

export function assertRecordSafeToPersist(record: object): void {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_RECORD_KEYS.has(key)) {
      throw new LifecycleError(
        `Refusing to persist "${key}": recovery records must never carry secrets (Invariant 6).`,
      )
    }
  }
}

/**
 * Build the record to persist at submission time.
 *
 * Parsing rather than casting means a malformed value fails here, at the moment
 * of writing, instead of on the recovery path after a crash — which is the one
 * path that is hardest to test and worst to get wrong.
 */
export function toRecoveryRecord(input: unknown): RecoveryRecord {
  const parsed = RecoveryRecordSchema.safeParse(input)
  if (!parsed.success) {
    throw new LifecycleError('Refusing to persist a malformed recovery record.')
  }
  assertRecordSafeToPersist(parsed.data)
  return parsed.data
}

export type PendingResolution =
  | { readonly action: 'settled'; readonly outcome: OperationOutcome }
  | { readonly action: 'still-pending'; readonly waitedSeconds: number }
  | { readonly action: 'needs-user-decision'; readonly reason: 'timed-out' }

/**
 * Decide what to do about an operation found in flight after a restart.
 *
 * THE RULE THIS ENCODES: there is no automatic resubmission, ever, and the
 * return type has no variant for it.
 *
 * The tempting behaviour, when an operation has been pending too long, is to
 * sign a fresh one and send it again. That is a double-spend waiting to happen:
 * the app cannot distinguish "the bundler dropped it" from "the bundler has it
 * and is slow", and if the original lands after the replacement, the user has
 * sent twice. Nonce reuse would make the second fail, but nothing guarantees
 * the replacement reuses the nonce once a signature is being rebuilt from
 * recovered state.
 *
 * So a stuck operation escalates to the user, who can be shown the operation
 * hash and asked how to proceed. Slower, and correct.
 *
 * @param receipt the receipt fetched for this record's hash, or null if the
 * bundler has none yet. Verified against the record before it is believed.
 */
export function resolvePendingOperation(args: {
  record: RecoveryRecord
  receipt: UserOperationReceipt | null
  nowSeconds: number
}): PendingResolution {
  const { record, receipt, nowSeconds } = args

  if (receipt !== null) {
    // Invariant 7: a receipt is a claim by a bundler until checked against
    // something we knew independently. Throws if it describes another operation.
    assertReceiptMatches(receipt, { userOpHash: record.userOpHash, sender: record.sender })
    return { action: 'settled', outcome: classifyReceipt(receipt) }
  }

  const waitedSeconds = nowSeconds - record.submittedAtSeconds

  /* A clock that moved backwards (timezone change, NTP correction, a user
     setting the date) must not present as a fresh submission that then waits
     the full timeout again. Treat it as no time having passed. */
  if (waitedSeconds < 0) return { action: 'still-pending', waitedSeconds: 0 }

  if (waitedSeconds >= SUBMISSION_TIMEOUT_SECONDS) {
    return { action: 'needs-user-decision', reason: 'timed-out' }
  }

  return { action: 'still-pending', waitedSeconds }
}

/**
 * Whether a fresh transfer may be started while another is unresolved.
 *
 * Blocking is the conservative choice: two operations in flight from one
 * account race on the nonce, and the loser fails after the user has already
 * approved it. Refusing up front is easier to explain than a failure that
 * arrives later with no obvious cause.
 */
export function canStartNewTransfer(pending: readonly RecoveryRecord[]): boolean {
  return pending.length === 0
}
