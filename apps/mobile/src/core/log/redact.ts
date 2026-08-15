/**
 * Redaction for anything that might reach a log, a crash report, or analytics.
 *
 * Invariant 6: never log, persist, or transmit raw email contents, DKIM
 * material, private keys, session key secrets, Semaphore identity secrets, or
 * full unredacted UserOperations containing signatures.
 *
 * The `core/` lint rule bans `console` outright, so nothing in the business
 * logic can leak by accident. This module is for the layers that legitimately
 * report errors — a crash handler, a diagnostics screen, a bug report — where
 * the object being reported may have travelled a long way from wherever those
 * fields were set.
 *
 * DESIGN CHOICE: redaction is by key name, and the list is a denylist.
 *
 * An allowlist would be safer in principle, and was considered. It was rejected
 * because it fails in the more dangerous direction *in practice*: an allowlist
 * that omits a benign field silently strips useful diagnostics, so the pressure
 * during an incident is always to widen it, in a hurry, without review. This
 * denylist is paired with a test that enumerates every sensitive field name
 * used anywhere in the codebase, so adding a new one without covering it here
 * fails CI. That test is the real control; this list is its implementation.
 */

/**
 * Key names whose values never appear in output.
 *
 * Matched case-insensitively, and as a substring, so `userOpSignature` and
 * `sessionKeySecret` are caught without needing to be listed. Substring
 * matching over-redacts rather than under-redacts, which is the correct bias.
 */
const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  'signature',
  'privatekey',
  'secret',
  'seed',
  'mnemonic',
  'password',
  'token',
  'credential',
  'dkim',
  'email',
  'proof',
  'nullifier',
  'identity',
  'calldata',
  'authenticatordata',
  'clientdata',
]

export const REDACTED = '[redacted]' as const

/** Guards against a cyclic or pathologically deep object costing real work. */
const MAX_DEPTH = 8

const TRUNCATED = '[truncated]' as const

function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase()
  return SENSITIVE_KEY_PATTERNS.some((pattern) => normalised.includes(pattern))
}

/**
 * Produce a copy of `value` safe to write to a log.
 *
 * Never mutates its input, never throws, and never returns the original object.
 * Total by construction: an unrecognised type is rendered as its typeof rather
 * than passed through, so a future value shape cannot leak by default.
 */
export function redactForLogging(value: unknown): unknown {
  return redact(value, 0, new WeakSet())
}

function redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return TRUNCATED

  if (value === null) return null

  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'undefined':
      return value
    case 'bigint':
      // JSON.stringify throws on bigint; logging must not be the thing that
      // crashes an error handler.
      return `${value.toString()}n`
    case 'function':
    case 'symbol':
      return `[${typeof value}]`
    default:
      break
  }

  if (typeof value !== 'object') return `[${typeof value}]`

  if (seen.has(value)) return '[circular]'
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen))
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message }
  }

  const output: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redact(nested, depth + 1, seen)
  }
  return output
}

/**
 * The field names this codebase treats as sensitive.
 *
 * Exported so a test can assert every one of them is actually redacted. Adding
 * a sensitive field to a type without adding it here fails that test, which is
 * what keeps the denylist above honest.
 */
export const KNOWN_SENSITIVE_FIELDS: readonly string[] = [
  'signature',
  'userOpSignature',
  'privateKey',
  'sessionKeySecret',
  'secret',
  'seedPhrase',
  'mnemonic',
  'password',
  'accessToken',
  'credentials',
  'dkimSignature',
  'emailBody',
  'rawEmail',
  'zkProof',
  'proof',
  'nullifierHash',
  'identityCommitment',
  'identitySecret',
  'callData',
  'authenticatorData',
  'clientDataJSON',
]
