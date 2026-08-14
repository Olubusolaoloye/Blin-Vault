import type { Address } from '../validation/primitives.js'

/**
 * The data model behind the confirmation screen.
 *
 * Invariant 8: every state-changing on-chain action shows the user a
 * plain-language confirmation of what it does, what it costs, and which factors
 * it requires — *before* any biometric prompt.
 *
 * That invariant is easy to state and easy to violate by accident: a loading
 * state that lets the user tap through, a fee that resolves after the prompt
 * opens, a recipient still being resolved. So the precondition is expressed
 * here as a function over data rather than left as a rule the UI is trusted to
 * follow, and `canPromptForBiometrics` is the single gate the UI must pass.
 *
 * Note on wording: this module emits *codes*, never user-facing sentences.
 * Copy lives in the UI layer, which owns the plain-language rules (no
 * "multisig", no "quorum", no "UserOperation" — see CLAUDE.md). Keeping strings
 * out of core is also what lets the copy be reviewed in one place.
 */

export type TokenRef =
  | { readonly kind: 'native'; readonly symbol: string; readonly decimals: number }
  | {
      readonly kind: 'erc20'
      readonly address: Address
      readonly symbol: string
      readonly decimals: number
    }

export interface TransferIntent {
  readonly to: Address
  /** Smallest unit of `token`. */
  readonly amount: bigint
  readonly token: TokenRef
  readonly chainId: number
}

export interface FeeQuote {
  /** Worst-case fee in the smallest unit of `token`. */
  readonly maxFee: bigint
  /** Which token actually pays — may differ from the token being sent. */
  readonly token: TokenRef
}

/**
 * Whether this recipient has been sent to before.
 *
 * In Phase 1 this drives a warning only. From Phase 3 the *contract* also
 * escalates on an unrecognised destination; this client-side view remains a
 * display convenience and never an enforcement mechanism (Invariant 4).
 */
export type RecipientFamiliarity = 'first-time' | 'known'

export type RequiredFactor = 'passkey' | 'email'

/**
 * Why the required factors are what they are. A code, not a sentence — the UI
 * maps these to plain language.
 */
export type FactorReason =
  /** Phase 1: the account has a passkey validator and nothing else installed. */
  | 'passkey-only-account'

export interface FactorRequirement {
  readonly factors: readonly RequiredFactor[]
  readonly reason: FactorReason
}

export interface TransferConfirmation {
  readonly intent: TransferIntent
  readonly fee: FeeQuote
  readonly recipient: RecipientFamiliarity
  /**
   * A MIRROR of the on-chain policy, shown so the user knows what is coming.
   * The contract is the sole source of truth (Invariant 4). If this and the
   * contract ever disagree, the contract wins and this is a bug.
   */
  readonly required: FactorRequirement
}

/** A set of addresses this account has previously sent to. */
export interface KnownRecipients {
  has(address: Address): boolean
}

export class InvalidTransferError extends Error {
  override readonly name = 'InvalidTransferError'
}

/**
 * Determine which factors this transfer needs.
 *
 * PHASE 1 SCOPE, STATED PLAINLY: a Phase 1 account has only a passkey validator
 * installed, so the passkey is the only factor there is — and, being the only
 * one, it is a single sufficient factor for any amount. Phase 1 therefore does
 * not satisfy Invariant 3. Value- and destination-based escalation arrives in
 * Phase 3 with the policy module, enforced on-chain.
 *
 * This function exists now, returning a constant, so that the confirmation
 * screen is built against the real shape from the start and Phase 3 changes one
 * function rather than the whole UI.
 */
export function requiredFactorsFor(_intent: TransferIntent): FactorRequirement {
  return { factors: ['passkey'], reason: 'passkey-only-account' }
}

export function classifyRecipient(
  to: Address,
  knownRecipients: KnownRecipients,
): RecipientFamiliarity {
  return knownRecipients.has(to) ? 'known' : 'first-time'
}

/**
 * Assemble everything the user must see before being asked for biometrics.
 *
 * Rejects intents that could not be honestly displayed: a zero or negative
 * amount, or a fee quote that is not yet known. Building a confirmation is the
 * only supported way to reach the biometric prompt.
 */
export function buildTransferConfirmation(args: {
  intent: TransferIntent
  fee: FeeQuote
  knownRecipients: KnownRecipients
}): TransferConfirmation {
  const { intent, fee, knownRecipients } = args

  if (intent.amount <= 0n) {
    throw new InvalidTransferError('Transfer amount must be greater than zero.')
  }
  if (fee.maxFee < 0n) {
    throw new InvalidTransferError('Fee quote must not be negative.')
  }

  return {
    intent,
    fee,
    recipient: classifyRecipient(intent.to, knownRecipients),
    required: requiredFactorsFor(intent),
  }
}

/**
 * The Invariant 8 gate: may the app open a biometric prompt for this?
 *
 * Only if everything with a consequence is already on screen — the amount, the
 * recipient, the fee and which token pays it, and the factors required. A UI
 * that opens Face ID before this returns true is violating Invariant 8, which
 * is why this is a function with tests rather than a convention.
 */
export function canPromptForBiometrics(confirmation: TransferConfirmation | null): boolean {
  if (confirmation === null) return false
  if (confirmation.intent.amount <= 0n) return false
  if (confirmation.required.factors.length === 0) return false
  return true
}

/**
 * Whether the UI must show the "you have never sent to this address" warning.
 *
 * Separate from `classifyRecipient` so the warning condition is a named,
 * testable thing rather than an inline comparison in a component.
 */
export function shouldWarnAboutRecipient(confirmation: TransferConfirmation): boolean {
  return confirmation.recipient === 'first-time'
}
