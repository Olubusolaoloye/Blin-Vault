import { describe, expect, it } from 'vitest'
import { DEFAULT_RATE_LIMIT, RateLimiter } from './rateLimit.js'

const NOW = 1_800_000_000_000

describe('RateLimiter', () => {
  it('allows requests up to the limit', () => {
    const limiter = new RateLimiter({ limit: 3, windowMs: 1000, maxTrackedKeys: 100 })

    for (let i = 0; i < 3; i++) {
      expect(limiter.check('a', NOW).allowed).toBe(true)
    }
  })

  it('refuses once the limit is reached', () => {
    const limiter = new RateLimiter({ limit: 2, windowMs: 1000, maxTrackedKeys: 100 })

    limiter.check('a', NOW)
    limiter.check('a', NOW)

    expect(limiter.check('a', NOW)).toMatchObject({ allowed: false, remaining: 0 })
  })

  it('reports a usable retry-after', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 5000, maxTrackedKeys: 100 })
    limiter.check('a', NOW)

    const verdict = limiter.check('a', NOW + 1000)
    expect(verdict.retryAfterSeconds).toBe(4)
  })

  it('never reports a retry-after of zero while refusing', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 500, maxTrackedKeys: 100 })
    limiter.check('a', NOW)

    const verdict = limiter.check('a', NOW + 499)
    expect(verdict.allowed).toBe(false)
    expect(verdict.retryAfterSeconds).toBeGreaterThanOrEqual(1)
  })

  it('starts a fresh window once the old one expires', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000, maxTrackedKeys: 100 })

    limiter.check('a', NOW)
    expect(limiter.check('a', NOW + 500).allowed).toBe(false)
    expect(limiter.check('a', NOW + 1001).allowed).toBe(true)
  })

  it('keeps callers independent', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000, maxTrackedKeys: 100 })

    expect(limiter.check('a', NOW).allowed).toBe(true)
    expect(limiter.check('b', NOW).allowed).toBe(true)
    expect(limiter.check('a', NOW).allowed).toBe(false)
  })

  describe('the limiter must not become the vulnerability', () => {
    /**
     * An unbounded map keyed by an attacker-controlled value is itself a
     * denial-of-service vector — the defense becoming the hole.
     */
    it('caps how many callers it tracks', () => {
      const limiter = new RateLimiter({ limit: 10, windowMs: 60_000, maxTrackedKeys: 50 })

      for (let i = 0; i < 500; i++) {
        limiter.check(`caller-${String(i)}`, NOW)
      }

      expect(limiter.trackedKeys).toBeLessThanOrEqual(50)
    })

    /**
     * Expiry must reclaim memory on its own, so a burst of one-off callers does
     * not hold the table at its cap indefinitely.
     */
    it('releases expired entries without needing the cap', () => {
      const limiter = new RateLimiter({ limit: 10, windowMs: 1000, maxTrackedKeys: 10_000 })

      for (let i = 0; i < 100; i++) limiter.check(`caller-${String(i)}`, NOW)
      expect(limiter.trackedKeys).toBe(100)

      limiter.check('later', NOW + 2000)
      expect(limiter.trackedKeys).toBe(1)
    })

    /**
     * A KNOWN AND ACCEPTED WEAKNESS, pinned so it stays a decision rather than
     * a surprise.
     *
     * The table is bounded, and eviction is oldest-first, so a caller who
     * floods it with distinct keys can evict a blocked caller's window and win
     * that caller a fresh allowance. This test asserts the weakness EXISTS
     * rather than pretending it does not — if the eviction policy changes, it
     * should fail and force a fresh decision.
     *
     * Why it is accepted: mounting it requires controlling maxTrackedKeys
     * distinct source addresses, and anyone with that many addresses can exceed
     * the limit directly by using them. The bypass grants no capability the
     * attacker did not already have, while the bound it buys prevents an
     * unbounded map from becoming its own denial-of-service vector.
     */
    it('can have a blocked window evicted by a flood — accepted tradeoff', () => {
      const limiter = new RateLimiter({ limit: 2, windowMs: 60_000, maxTrackedKeys: 5 })

      limiter.check('victim', NOW)
      limiter.check('victim', NOW)
      expect(limiter.check('victim', NOW).allowed).toBe(false)

      for (let i = 0; i < 50; i++) limiter.check(`flood-${String(i)}`, NOW)

      expect(limiter.check('victim', NOW).allowed).toBe(true)
      expect(limiter.trackedKeys).toBeLessThanOrEqual(5)
    })

    /**
     * Without table pressure the window holds firm, which is the case that
     * matters for an ordinary abusive client.
     */
    it('holds a blocked window when the table is not under pressure', () => {
      const limiter = new RateLimiter({ limit: 2, windowMs: 60_000, maxTrackedKeys: 10_000 })

      limiter.check('victim', NOW)
      limiter.check('victim', NOW)

      for (let i = 0; i < 50; i++) limiter.check(`other-${String(i)}`, NOW)

      expect(limiter.check('victim', NOW).allowed).toBe(false)
    })
  })

  it('ships a sane default', () => {
    expect(DEFAULT_RATE_LIMIT.limit).toBeGreaterThan(0)
    expect(DEFAULT_RATE_LIMIT.windowMs).toBeGreaterThan(0)
    expect(DEFAULT_RATE_LIMIT.maxTrackedKeys).toBeGreaterThan(0)
  })
})
