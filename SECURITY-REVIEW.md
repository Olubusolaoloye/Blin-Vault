# Security self-review — Phase 1

Phase 1, Task 11. A dedicated adversarial pass over the code that exists, not a
side effect of writing it.

**Reviewed:** commit `963af94` plus the fix recorded below.
**Scope:** `apps/mobile/src/core/**` and repository configuration. There is no
app shell, no UI, and no contracts yet, so the UI- and device-specific hazards
in Task 11 are listed as *not reviewable here* rather than as passes.

A "found nothing" result is only meaningful if it says what was looked at, so
each hazard below records the actual search, not just the verdict.

---

## Findings

### 1. An unknown fee could reach the biometric prompt — FIXED

**Severity: high.** A direct Invariant 8 violation, reachable without anyone
writing a bug.

`FeeQuote` was `{ maxFee: bigint; token: TokenRef }`, and `0n` was documented and
tested as meaning "a paymaster is sponsoring this". But there was no way to
represent "the estimate has not come back yet". Those are opposite facts sharing
one encoding.

The failure path: a confirmation screen renders while gas estimation is still in
flight. The natural placeholder is `0n`. That builds a valid
`TransferConfirmation`, `canPromptForBiometrics` returns `true`, and Face ID
opens over a screen showing a cost that is not real. The user approves a fee
they were never shown — precisely what Invariant 8 exists to prevent.

**Fix:** `FeeQuote` is now a discriminated union — `{ kind: 'sponsored' }` or
`{ kind: 'charged', maxFee, token }`. "Unknown" is unrepresentable, so a caller
without a fee cannot construct a `FeeQuote`, cannot construct a
`TransferConfirmation`, and cannot reach the prompt. The compiler enforces it
rather than a runtime check that has to remember to run.

A `@ts-expect-error` test pins the property: if that directive ever reports as
unused, the hole has reopened.

### 2. `Address` is structural, not nominal — ACCEPTED, documented

**Severity: low, with a caveat.**

`Address` resolves to viem's `` `0x${string}` ``. It is a template-literal type,
not a brand, so it records *shape*, not *provenance*. `'0xdeadbeef' as Address`
is rejected only because of its shape; any well-formed 40-hex-digit string
type-checks without ever passing `AddressSchema` and its checksum validation.

Every current entry point does parse — `parsePaymentUri`, `toRecoveryRecord`,
and the bundler schemas all go through `AddressSchema`. So the codebase is
correct today. The risk is future drift: nothing stops a later caller from
constructing a `TransferIntent` with an unvalidated string.

Not fixed now because branding `Address` breaks assignability with viem's own
`Address` across every call site, which is a wide change to make while the UI
layer that would exercise it does not exist. **Revisit when the app shell
lands** — that is when unvalidated strings start arriving from React state.

Mitigating factor: the one place a mismatch matters most, known-recipient
comparison, fails safe. A casing or validation mismatch makes a recipient look
*unfamiliar*, producing an extra warning rather than suppressing one.

### 3. CI actions are pinned by tag, not commit SHA — ACCEPTED, deferred

**Severity: low now, higher at mainnet.**

`.github/workflows/ci.yml` uses `actions/checkout@v4`, `pnpm/action-setup@v4`,
`actions/setup-node@v4`. Tags are mutable; a compromised or retagged action
would execute in CI.

Today CI holds no secrets and publishes nothing, so the blast radius is a
misleading green check. That changes the moment CI gains a deployment key or
publishes a build. **Pin to SHAs before any workflow touches a secret.**

---

## Hazards searched, nothing found

| Hazard | How it was checked | Result |
|---|---|---|
| Key material in logs | `grep -rn "console\.\|process\.stdout\|process\.stderr" apps/ services/` | No logging anywhere in source. The `core/` ESLint rule bans `console` outright, so this is enforced, not merely observed |
| Key material in storage | `grep -rn "AsyncStorage\|localStorage\|SecureStore\|writeFile\|fs\."` | No persistence layer exists yet. The only thing designed to be persisted is `RecoveryRecord`, which carries a public operation hash and is guarded by `assertRecordSafeToPersist` |
| Secrets committed | `git ls-files \| grep -E "\.env"` | Only `.env.example`, which contains a localhost URL and a testnet chain id. `.gitignore` excludes `.env*` and re-includes the example |
| Escape hatches in the type system | `grep -rnE ": *any\b\|as any\b\|@ts-ignore\|@ts-expect-error\|!\."` over non-test source | None. The single `@ts-expect-error` is in a test and is load-bearing (finding 1) |
| Unparsed external input reaching logic | Enumerated every exported function in `core/`, traced argument provenance | Every boundary — payment URIs, bundler receipts, gas estimates, recovery records — parses with Zod before use |
| Client-side check presented as enforcement | `grep -rn "enforce"` across `core/` | Every hit either points at on-chain enforcement or explicitly disclaims itself as a mirror (Invariant 4) |
| Implicit trust in the proxy | Reviewed `bundler.ts` against Invariant 7 | Receipts are verified against a locally known hash and sender; gas quotes are bounded; unknown vendor fields are stripped rather than trusted. Nothing treats a proxy or bundler response as authoritative |
| Automatic resubmission / double-spend | Reviewed `lifecycle.ts`; `PendingResolution` has no resubmit variant | Structurally impossible to return one; a test asserts this across elapsed times up to 30 days |

---

## Not reviewable in this environment

Listed so they are not mistaken for passes. See `CLAUDE.md` → Environment limits.

- **Screenshot suppression on sensitive screens** — needs a UI layer
- **Sensitive state cleared on backgrounding** — needs an app lifecycle
- **Jailbreak/root detection** — needs a device
- **Any path reaching a state-changing call without the confirmation screen** —
  partially reviewable: `canPromptForBiometrics` is the gate and is tested, but
  whether the UI *actually calls it* cannot be verified without the UI
- **Key material in crash reports and analytics** — no crash reporter integrated
  yet. `redactForLogging` exists for that integration; it is untested against a
  real reporter
- **Contract-level review** — no Solidity exists until Phase 3

---

## Standing caveat

Phase 1 does not satisfy Invariant 3. A passkey-only account has exactly one
sufficient factor for any amount, and no amount of review of this code changes
that — it is a property of the phase, closing in Phase 3 when the policy module
lands on-chain. Nothing in this review should be read as suggesting Phase 1
delivers threshold security.
