/**
 * Client-side view of session key bounds.
 *
 * A session key lets small, routine transfers go through without a fresh
 * biometric prompt every time. The bounds that make that safe — a value ceiling
 * and a validity window — are enforced ON-CHAIN by the SmartSessions policies
 * (`value-limit-policy`, `time-frame-policy`). See ARCHITECTURE.md §4.
 *
 * Everything in this module is a MIRROR of that on-chain state (Invariant 4).
 * Its job is to tell the user what will happen before it happens, and to avoid
 * submitting transactions that the account is going to reject anyway. It is
 * never the thing that stops a transfer. If this module and the contract
 * disagree, the contract wins and this module has a bug.
 */

export interface SessionBounds {
  /** Largest value a single transfer may carry, in wei. */
  readonly maxValuePerTransfer: bigint
  /** Unix seconds, inclusive. */
  readonly validAfter: number
  /** Unix seconds, exclusive. */
  readonly validUntil: number
}

export type SessionRejection =
  | 'no-session'
  | 'not-yet-valid'
  | 'expired'
  | 'value-exceeds-limit'

export type SessionCheck = { readonly ok: true } | { readonly ok: false; readonly reason: SessionRejection }

/**
 * How far ahead of the device clock we treat a session as already finished.
 *
 * WHY: the on-chain time-frame check runs against block timestamps, not the
 * phone's clock, and the two drift. A session the device believes is valid for
 * another few seconds may already be expired from the chain's point of view.
 *
 * The failure that causes is not a security hole — the account correctly
 * rejects the operation — but it is a bad one: the user has already approved a
 * transfer that then fails for reasons they cannot see. Retiring the session
 * early instead means the app asks for a fresh biometric confirmation, which is
 * a slightly higher-friction path that always works.
 *
 * The margin is deliberately one-sided. We never treat an expired session as
 * still valid; we only ever give up on one sooner.
 */
export const CLOCK_SKEW_MARGIN_SECONDS = 30

export class InvalidSessionBoundsError extends Error {
  override readonly name = 'InvalidSessionBoundsError'
}

/**
 * SmartSessions policies this app is permitted to install.
 *
 * `sudo-policy` is absent by construction rather than by convention. It grants
 * an unbounded session — no value ceiling, no expiry — which would hand a
 * single unattended key the ability to drain the account and defeat the entire
 * purpose of session bounds. It must never appear in an install path.
 */
export const ALLOWED_SESSION_POLICIES = ['value-limit-policy', 'time-frame-policy'] as const

export type AllowedSessionPolicy = (typeof ALLOWED_SESSION_POLICIES)[number]

const FORBIDDEN_SESSION_POLICIES = new Set(['sudo-policy'])

/**
 * Reject any policy set that is not strictly within the allowlist.
 *
 * Allowlist rather than denylist: a policy nobody has reviewed is not safe to
 * install merely because it is not named `sudo-policy`.
 */
export function assertPoliciesInstallable(policies: readonly string[]): void {
  for (const policy of policies) {
    if (FORBIDDEN_SESSION_POLICIES.has(policy)) {
      throw new InvalidSessionBoundsError(
        `Refusing to install "${policy}": an unbounded session defeats session bounds entirely.`,
      )
    }
    if (!ALLOWED_SESSION_POLICIES.includes(policy as AllowedSessionPolicy)) {
      throw new InvalidSessionBoundsError(`Refusing to install unreviewed policy "${policy}".`)
    }
  }
}

/** Reject bounds that could not be honestly described to a user. */
export function assertBoundsCoherent(bounds: SessionBounds): void {
  if (bounds.maxValuePerTransfer <= 0n) {
    throw new InvalidSessionBoundsError('Session value ceiling must be greater than zero.')
  }
  if (!Number.isInteger(bounds.validAfter) || !Number.isInteger(bounds.validUntil)) {
    throw new InvalidSessionBoundsError('Session validity window must be whole seconds.')
  }
  if (bounds.validUntil <= bounds.validAfter) {
    throw new InvalidSessionBoundsError('Session must end after it begins.')
  }
}

/**
 * Whether a transfer can go through the session key, or needs a fresh prompt.
 *
 * Returns a reason on rejection so the UI can explain the extra step in plain
 * language rather than presenting an unexplained biometric prompt.
 */
export function checkAgainstSession(args: {
  bounds: SessionBounds | null
  value: bigint
  nowSeconds: number
}): SessionCheck {
  const { bounds, value, nowSeconds } = args

  if (bounds === null) return { ok: false, reason: 'no-session' }
  if (nowSeconds < bounds.validAfter) return { ok: false, reason: 'not-yet-valid' }

  // Expire early, never late — see CLOCK_SKEW_MARGIN_SECONDS.
  if (nowSeconds + CLOCK_SKEW_MARGIN_SECONDS >= bounds.validUntil) {
    return { ok: false, reason: 'expired' }
  }

  if (value > bounds.maxValuePerTransfer) return { ok: false, reason: 'value-exceeds-limit' }

  return { ok: true }
}

/**
 * Seconds of usable session life remaining, after the skew margin.
 *
 * Zero once the session should no longer be relied on, so a countdown shown to
 * the user matches the moment the app actually stops using the session.
 */
export function remainingSessionSeconds(bounds: SessionBounds, nowSeconds: number): number {
  const remaining = bounds.validUntil - CLOCK_SKEW_MARGIN_SECONDS - nowSeconds
  return remaining > 0 ? remaining : 0
}
