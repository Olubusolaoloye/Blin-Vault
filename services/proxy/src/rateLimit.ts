/**
 * Ephemeral rate limiting.
 *
 * A DESIGN TENSION, STATED RATHER THAN PAPERED OVER.
 *
 * ARCHITECTURE.md §7 says the proxy knows nothing and persists nothing. Rate
 * limiting is the one mechanism that needs to remember something about callers,
 * and it is not optional: the proxy holds API keys precisely because they get
 * abused, and an unlimited endpoint holding those keys is the abuse.
 *
 * The resolution is to make what it remembers as close to nothing as possible:
 *
 *   - Keyed on a transport identifier only. Never on an account address, never
 *     on anything that links two requests to the same wallet. The limiter must
 *     not become a way to learn who is transacting.
 *   - In memory only. Nothing reaches disk, so the guarantee survives a stolen
 *     server disk and there is no log to subpoena.
 *   - Short-lived. Entries expire with the window, so the working set is
 *     "callers in the last minute" rather than a history.
 *   - Bounded. The table is capped, because an unbounded map keyed by
 *     attacker-controlled values is itself a denial-of-service vector — the
 *     defense becoming the vulnerability.
 *
 * This is a real weakening of "knows nothing", and it is deliberate. If it ever
 * needs to key on anything richer than a transport identifier, that is a
 * decision for the human, not a refactor.
 *
 * KNOWN WEAKNESS, accepted: because the table is bounded and eviction is
 * oldest-first, a caller who floods it with distinct keys can evict a blocked
 * caller's window and win that caller a fresh allowance. Mounting it requires
 * controlling `maxTrackedKeys` distinct source addresses — and anyone with that
 * many addresses can exceed the limit directly by using them, so the bypass
 * grants no capability they did not already have. The bound it buys is what
 * stops an unbounded map from becoming its own denial-of-service vector. A test
 * pins this behaviour so a change to the eviction policy forces a fresh
 * decision rather than silently altering the tradeoff.
 */

export interface RateLimitConfig {
  /** Requests permitted per window. */
  readonly limit: number
  readonly windowMs: number
  /**
   * Maximum distinct callers tracked at once. Beyond this the limiter sheds
   * the oldest entries rather than growing without bound.
   */
  readonly maxTrackedKeys: number
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  limit: 120,
  windowMs: 60_000,
  maxTrackedKeys: 10_000,
}

interface Window {
  count: number
  resetAt: number
}

export interface RateLimitResult {
  readonly allowed: boolean
  readonly remaining: number
  /** Seconds until the window resets, for a Retry-After header. */
  readonly retryAfterSeconds: number
}

export class RateLimiter {
  readonly #windows = new Map<string, Window>()
  readonly #config: RateLimitConfig

  constructor(config: RateLimitConfig = DEFAULT_RATE_LIMIT) {
    this.#config = config
  }

  /**
   * @param key a transport identifier. Never pass an account address or
   * anything else that identifies a user rather than a connection.
   * @param now injected so behaviour is testable without waiting on wall clock.
   */
  check(key: string, now: number): RateLimitResult {
    this.#evictExpired(now)

    const existing = this.#windows.get(key)

    if (existing === undefined || now >= existing.resetAt) {
      /* Only enforce the cap when adding a NEW key, and only after eviction —
         so a full table cannot lock out callers already inside their window. */
      if (this.#windows.size >= this.#config.maxTrackedKeys) {
        this.#evictOldest()
      }
      this.#windows.set(key, { count: 1, resetAt: now + this.#config.windowMs })
      return { allowed: true, remaining: this.#config.limit - 1, retryAfterSeconds: 0 }
    }

    if (existing.count >= this.#config.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      }
    }

    existing.count += 1
    return {
      allowed: true,
      remaining: this.#config.limit - existing.count,
      retryAfterSeconds: 0,
    }
  }

  /** Visible for tests: how many callers are currently tracked. */
  get trackedKeys(): number {
    return this.#windows.size
  }

  #evictExpired(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now >= window.resetAt) this.#windows.delete(key)
    }
  }

  #evictOldest(): void {
    // Map preserves insertion order, so the first key is the oldest.
    const oldest = this.#windows.keys().next()
    if (!oldest.done) this.#windows.delete(oldest.value)
  }
}
