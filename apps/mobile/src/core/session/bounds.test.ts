import { describe, expect, it } from 'vitest'
import {
  ALLOWED_SESSION_POLICIES,
  assertBoundsCoherent,
  assertPoliciesInstallable,
  checkAgainstSession,
  CLOCK_SKEW_MARGIN_SECONDS,
  InvalidSessionBoundsError,
  remainingSessionSeconds,
  type SessionBounds,
} from './bounds.js'

const NOW = 1_800_000_000

const BOUNDS: SessionBounds = {
  maxValuePerTransfer: 10n ** 16n, // 0.01 ETH
  validAfter: NOW - 3_600,
  validUntil: NOW + 3_600,
}

describe('checkAgainstSession', () => {
  it('permits a transfer within both bounds', () => {
    expect(checkAgainstSession({ bounds: BOUNDS, value: 10n ** 15n, nowSeconds: NOW })).toEqual({
      ok: true,
    })
  })

  it('permits a transfer exactly at the value ceiling', () => {
    expect(
      checkAgainstSession({ bounds: BOUNDS, value: BOUNDS.maxValuePerTransfer, nowSeconds: NOW }),
    ).toEqual({ ok: true })
  })

  it('rejects a transfer one wei over the ceiling', () => {
    expect(
      checkAgainstSession({
        bounds: BOUNDS,
        value: BOUNDS.maxValuePerTransfer + 1n,
        nowSeconds: NOW,
      }),
    ).toEqual({ ok: false, reason: 'value-exceeds-limit' })
  })

  it('rejects when there is no session at all', () => {
    expect(checkAgainstSession({ bounds: null, value: 1n, nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'no-session',
    })
  })

  it('rejects before the window opens', () => {
    expect(
      checkAgainstSession({ bounds: BOUNDS, value: 1n, nowSeconds: BOUNDS.validAfter - 1 }),
    ).toEqual({ ok: false, reason: 'not-yet-valid' })
  })

  it('rejects after the window closes', () => {
    expect(
      checkAgainstSession({ bounds: BOUNDS, value: 1n, nowSeconds: BOUNDS.validUntil + 1 }),
    ).toEqual({ ok: false, reason: 'expired' })
  })

  /**
   * Clock skew. The on-chain check runs against block timestamps, not the
   * phone's clock. Inside the margin the device still believes the session is
   * live, and submitting would produce a transfer the user already approved
   * failing for reasons they cannot see. Giving up early costs one biometric
   * prompt and always works.
   */
  it('retires the session early, within the skew margin', () => {
    const justInsideMargin = BOUNDS.validUntil - CLOCK_SKEW_MARGIN_SECONDS + 1

    expect(justInsideMargin).toBeLessThan(BOUNDS.validUntil)
    expect(checkAgainstSession({ bounds: BOUNDS, value: 1n, nowSeconds: justInsideMargin })).toEqual(
      { ok: false, reason: 'expired' },
    )
  })

  it('still permits a transfer just outside the margin', () => {
    const outsideMargin = BOUNDS.validUntil - CLOCK_SKEW_MARGIN_SECONDS - 1
    expect(checkAgainstSession({ bounds: BOUNDS, value: 1n, nowSeconds: outsideMargin })).toEqual({
      ok: true,
    })
  })

  /**
   * The margin must only ever shorten a session. A margin applied in the other
   * direction would treat an expired session as live, which is the one
   * direction that is not safe.
   */
  it('never extends a session past its stated end', () => {
    for (const offset of [0, 1, CLOCK_SKEW_MARGIN_SECONDS, CLOCK_SKEW_MARGIN_SECONDS * 2]) {
      expect(
        checkAgainstSession({ bounds: BOUNDS, value: 1n, nowSeconds: BOUNDS.validUntil + offset }),
      ).toEqual({ ok: false, reason: 'expired' })
    }
  })

  it('reports expiry before complaining about value, so the user is told the real blocker', () => {
    expect(
      checkAgainstSession({
        bounds: BOUNDS,
        value: BOUNDS.maxValuePerTransfer + 1n,
        nowSeconds: BOUNDS.validUntil + 1,
      }),
    ).toEqual({ ok: false, reason: 'expired' })
  })
})

describe('remainingSessionSeconds', () => {
  it('excludes the skew margin so a countdown matches real behaviour', () => {
    expect(remainingSessionSeconds(BOUNDS, NOW)).toBe(3_600 - CLOCK_SKEW_MARGIN_SECONDS)
  })

  it('reaches zero exactly when the session stops being used', () => {
    const cutoff = BOUNDS.validUntil - CLOCK_SKEW_MARGIN_SECONDS
    expect(remainingSessionSeconds(BOUNDS, cutoff)).toBe(0)
    expect(checkAgainstSession({ bounds: BOUNDS, value: 1n, nowSeconds: cutoff }).ok).toBe(false)
  })

  it('never reports negative time', () => {
    expect(remainingSessionSeconds(BOUNDS, BOUNDS.validUntil + 10_000)).toBe(0)
  })
})

describe('assertPoliciesInstallable', () => {
  it('accepts the reviewed policy set', () => {
    expect(() => { assertPoliciesInstallable([...ALLOWED_SESSION_POLICIES]); }).not.toThrow()
  })

  /**
   * sudo-policy grants an unbounded session — no ceiling, no expiry — which
   * would let a single unattended key drain the account.
   */
  it('refuses sudo-policy', () => {
    expect(() => { assertPoliciesInstallable(['sudo-policy']); }).toThrow(InvalidSessionBoundsError)
  })

  it('refuses sudo-policy even alongside legitimate policies', () => {
    expect(() =>
      { assertPoliciesInstallable(['value-limit-policy', 'sudo-policy', 'time-frame-policy']); },
    ).toThrow(InvalidSessionBoundsError)
  })

  it('refuses an unreviewed policy rather than allowing anything not named sudo', () => {
    expect(() => { assertPoliciesInstallable(['universal-action-policy']); }).toThrow(
      InvalidSessionBoundsError,
    )
  })

  it('does not list sudo-policy among the allowed policies', () => {
    expect(ALLOWED_SESSION_POLICIES).not.toContain('sudo-policy')
  })
})

describe('assertBoundsCoherent', () => {
  it('accepts coherent bounds', () => {
    expect(() => { assertBoundsCoherent(BOUNDS); }).not.toThrow()
  })

  it.each([
    ['a zero ceiling', { ...BOUNDS, maxValuePerTransfer: 0n }],
    ['a negative ceiling', { ...BOUNDS, maxValuePerTransfer: -1n }],
    ['an end before the start', { ...BOUNDS, validUntil: BOUNDS.validAfter - 1 }],
    ['a zero-length window', { ...BOUNDS, validUntil: BOUNDS.validAfter }],
    ['a fractional timestamp', { ...BOUNDS, validUntil: BOUNDS.validUntil + 0.5 }],
  ])('rejects %s', (_label, bounds) => {
    expect(() => { assertBoundsCoherent(bounds); }).toThrow(InvalidSessionBoundsError)
  })
})
