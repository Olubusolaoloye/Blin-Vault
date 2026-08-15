import { z } from 'zod'
import { AddressSchema, Hash32Schema, QuantitySchema } from '../validation/primitives.js'

/**
 * The bundler boundary.
 *
 * Invariant 7: bundlers and paymasters are transport, not trust. A hostile
 * bundler must be able to censor us but never to forge a transaction.
 *
 * That invariant holds cryptographically — a bundler cannot produce a valid
 * signature — but it does NOT follow that bundler *responses* can be believed.
 * A malicious or broken bundler can still:
 *
 *   - report a receipt for an operation that is not ours
 *   - report success for an operation that actually reverted
 *   - quote absurd gas limits, which the user then signs over
 *   - return well-formed nonsense, or nothing at all
 *
 * None of those steal funds by forgery; all of them mislead the user about what
 * happened to their money. So every field this module consumes is parsed, and
 * every claim about *our* operation is checked against something we already
 * knew independently.
 *
 * Shapes verified against viem 2.55.16's account-abstraction RPC types
 * (EntryPoint v0.7).
 */

/**
 * Response to `eth_estimateUserOperationGas`.
 *
 * Unknown fields are stripped rather than rejected: bundlers legitimately add
 * vendor extensions, and refusing them would couple us to one provider — which
 * is the coupling Invariant 7 exists to prevent.
 */
export const EstimateUserOperationGasSchema = z.object({
  preVerificationGas: QuantitySchema,
  verificationGasLimit: QuantitySchema,
  callGasLimit: QuantitySchema,
  paymasterVerificationGasLimit: QuantitySchema.optional(),
  paymasterPostOpGasLimit: QuantitySchema.optional(),
})

export type UserOperationGasEstimate = z.output<typeof EstimateUserOperationGasSchema>

/** Response to `eth_getUserOperationReceipt`, limited to the fields we rely on. */
export const UserOperationReceiptSchema = z.object({
  userOpHash: Hash32Schema,
  sender: AddressSchema,
  nonce: QuantitySchema,
  actualGasCost: QuantitySchema,
  actualGasUsed: QuantitySchema,
  /**
   * Whether the *operation* succeeded. Distinct from whether the enclosing
   * transaction was mined — see classifyReceipt.
   */
  success: z.boolean(),
  reason: z.string().optional(),
})

export type UserOperationReceipt = z.output<typeof UserOperationReceiptSchema>

export class BundlerResponseError extends Error {
  override readonly name = 'BundlerResponseError'
}

/**
 * Total gas the account will be charged for, across every phase.
 *
 * bigint throughout: these are uint256 values and JavaScript numbers cannot
 * hold them without loss.
 */
export function totalGasLimit(estimate: UserOperationGasEstimate): bigint {
  return (
    estimate.preVerificationGas +
    estimate.verificationGasLimit +
    estimate.callGasLimit +
    (estimate.paymasterVerificationGasLimit ?? 0n) +
    (estimate.paymasterPostOpGasLimit ?? 0n)
  )
}

/**
 * Reject a gas quote that is not plausible for the operation we are building.
 *
 * A bundler cannot forge a signature, but it CAN quote a wildly inflated gas
 * limit. The user would be signing those limits, and while the fee does appear
 * on the confirmation screen (Invariant 8), "the user should have noticed" is
 * not a control. A ceiling turns a silent overpayment into an explicit error
 * with a provider to fail over to.
 *
 * The ceiling belongs to the caller because it depends on the operation: a
 * first transaction that also deploys the account legitimately costs far more
 * than a subsequent transfer.
 */
export function assertGasEstimateSane(
  estimate: UserOperationGasEstimate,
  ceilingGas: bigint,
): void {
  if (ceilingGas <= 0n) {
    throw new BundlerResponseError('Gas ceiling must be positive.')
  }

  const total = totalGasLimit(estimate)
  if (total > ceilingGas) {
    throw new BundlerResponseError(
      `Bundler quoted ${total.toString()} gas, above the ${ceilingGas.toString()} ceiling for this operation.`,
    )
  }
}

/**
 * Verify a receipt actually describes the operation we submitted.
 *
 * THE POINT OF THIS FUNCTION: `userOpHash` in the response is a claim made by
 * the bundler, not a fact. Without checking it against the hash we computed
 * before submitting, a bundler could return any successful receipt and the app
 * would cheerfully report "sent" for an operation the user never authorised —
 * or, more mundanely, a confused bundler could hand back someone else's.
 *
 * The sender check is the same reasoning applied to the account: a receipt for
 * a different account tells us nothing about ours.
 *
 * Both comparisons are against values we knew independently before the bundler
 * was involved. That is what makes this a check rather than a formality.
 */
export function assertReceiptMatches(
  receipt: UserOperationReceipt,
  expected: { userOpHash: string; sender: string },
): void {
  if (receipt.userOpHash.toLowerCase() !== expected.userOpHash.toLowerCase()) {
    throw new BundlerResponseError(
      'Bundler returned a receipt for a different operation than the one submitted.',
    )
  }
  if (receipt.sender.toLowerCase() !== expected.sender.toLowerCase()) {
    throw new BundlerResponseError(
      'Bundler returned a receipt for a different account than this wallet.',
    )
  }
}

export type OperationOutcome =
  | { readonly status: 'succeeded'; readonly gasCost: bigint }
  | { readonly status: 'reverted'; readonly gasCost: bigint; readonly reason: string | null }

/**
 * Interpret a verified receipt.
 *
 * A UserOperation can be included on-chain and still revert. The transaction
 * "succeeded" in the sense that it was mined, the user was charged gas, and
 * nothing moved. Reporting that as a completed transfer is the single most
 * misleading thing this app could do, so the two cases are separated in the
 * type and the caller cannot read one as the other by accident.
 *
 * Call `assertReceiptMatches` first — this function assumes the receipt is ours.
 */
export function classifyReceipt(receipt: UserOperationReceipt): OperationOutcome {
  if (receipt.success) {
    return { status: 'succeeded', gasCost: receipt.actualGasCost }
  }
  return {
    status: 'reverted',
    gasCost: receipt.actualGasCost,
    reason: receipt.reason ?? null,
  }
}

/**
 * Parse an untrusted bundler payload into a receipt.
 *
 * Separate from the schema so callers get a typed error rather than a Zod
 * issue tree, and so there is one obvious place where "this came from a
 * bundler" is turned into "this is a receipt".
 */
export function parseUserOperationReceipt(payload: unknown): UserOperationReceipt {
  const parsed = UserOperationReceiptSchema.safeParse(payload)
  if (!parsed.success) {
    throw new BundlerResponseError('Bundler returned a malformed operation receipt.')
  }
  return parsed.data
}

export function parseGasEstimate(payload: unknown): UserOperationGasEstimate {
  const parsed = EstimateUserOperationGasSchema.safeParse(payload)
  if (!parsed.success) {
    throw new BundlerResponseError('Bundler returned a malformed gas estimate.')
  }
  return parsed.data
}
