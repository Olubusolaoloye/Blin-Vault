# PHASES.md — Blin Vault

Five phases. One at a time. Stop at every gate.

Phase 1 is broken into concrete tasks below with a testable definition of done
for each. Phases 2–5 are sketched only — they get the same treatment when their
turn comes, not before.

---

## Phase overview

| Phase | Delivers | Status |
|---|---|---|
| 1 | Passkey smart account, no ZK | **Not started — awaiting approval of design docs** |
| 2 | zkEmail recovery | Not started |
| 3 | Risk-adaptive quorum | Not started |
| 4 | Anonymous guardians | Not started |
| 5 | Hardening and scale | Not started |

---

# Phase 1 — Passkey smart account

**Goal.** An ERC-7579 account with a passkey validator only. Create a wallet,
view a balance, send with biometric approval, and use session keys with value and
time bounds. Multi-chain config with per-chain P-256 strategy. Full test suite.

**This phase must feel complete and polished on its own.** It is the foundation
everything else installs onto.

**What Phase 1 is not.** It does not satisfy Invariant 3. With only a passkey
validator installed, the passkey is a single sufficient factor for any amount.
Session bounds constrain an unattended session, not the passkey. Do not describe
this phase as delivering threshold security in docs, copy, or a demo.

---

## Task 1 — Repo scaffolding and toolchain

Monorepo per `ARCHITECTURE.md` §8. Expo app with dev client, TypeScript strict,
ESLint, Vitest, Foundry, Zod. All dependencies pinned exactly. `.env.example`
committed, `.env` git-ignored.

Lint rule enforcing that `core/` contains no React imports.

**Done when:** `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass clean on a
fresh clone with no network access beyond the registry; the `core/`-purity lint
rule fails a deliberately added React import in `core/`; `CLAUDE.md`'s Commands
section is updated to match what actually exists.

---

## Task 2 — Passkey spike

Resolve open question 2 from `ARCHITECTURE.md`: does `react-native-passkey@3.6.1`
work under Expo dev client on both platforms without patching? Create and assert
a credential on both a real iOS device and a real Android device. Associated
domains (iOS) and Digital Asset Links (Android) configured for real — documented
end to end, not stubbed.

If it does not work, fall back to `react-native-passkeys@0.4.2` and record why.

**Done when:** a credential is created and asserted on both platforms against our
own domain association; the setup is written up such that a new engineer can
reproduce it from the doc alone; the chosen library is pinned with the decision
recorded. If neither library works, **stop and report** rather than working
around it.

---

## Task 3 — Chain config and P-256 capability probe

Chain registry with Base Sepolia as the only entry (testnet-only until after
audit — decision 4). Implement the behavioural probe from `ARCHITECTURE.md` §3:
call `0x100` with a known-good vector, require exactly 32-byte `1`, cache per
chain ID.

Verify on-chain that the Rhinestone module addresses exported by the SDK are
actually deployed on Base Sepolia (open question 1). Hardcode nothing before
that check passes.

**Done when:** the probe correctly reports *present* on Base Sepolia and *absent*
against a local Anvil chain with no precompile; a test asserts that an empty
`0x100` is classified absent and never as "signature invalid"; gas estimation is
selected from the probe result, with a test for each branch; module addresses are
confirmed live and the confirmation is recorded.

**Status: mostly complete.** The probe, the capability cache, the chain
registry, and their unit tests are built and passing.

The real-EVM check is **done**, by a route that did not need Anvil. `@ethereumjs/evm`
installs from npm (which egress permits) and supports both `Prague` and `Osaka`,
so `p256.evm.test.ts` exercises the precompile present and absent against an
actual EVM. It demonstrates that a CALL to an empty `0x100` succeeds with empty
returndata and zero gas — byte-identical to RIP-7212 reporting an invalid
signature — that a genuinely invalid signature at the same address is likewise
indistinguishable, and that the precompile charges exactly the 6900 gas the code
budgets. The central security claim is now shown rather than assumed, and it
runs in CI.

Two DoD items remain blocked (see `CLAUDE.md` → Environment limits): probing
Base Sepolia specifically, and confirming the Rhinestone module addresses are
deployed. Both need live-chain egress.

**Amended during implementation.** The original DoD said gas estimation selects
"3450 vs 6900 vs fallback." That distinction turns out not to be soundly
detectable: for a *valid* signature RIP-7212 and EIP-7951 are byte-identical in
address, input, and output, so separating them would need a gas-constrained
probe. The 3450 gas difference is negligible on an L2 while an under-estimate
fails a transaction the user already approved, so the implementation budgets the
conservative 6900 for any precompile and documents why.

---

## Task 4 — Account construction

Counterfactual Safe7579 address derivation via `toSafeSmartAccount`. Address is
displayable and fundable before deployment. `attesters` and `attestersThreshold`
set deliberately, with the choice documented per `ARCHITECTURE.md` §2.

**Done when:** the counterfactual address is stable across app restarts and cold
installs given the same passkey; the address derived off-chain matches the
address the account actually deploys to on Base Sepolia; the attester
configuration is documented with its security rationale.

---

## Task 5 — Wallet creation and first deployment

Create-wallet flow: generate passkey → derive account → install the WebAuthn
validator via `getWebAuthnValidator` → lazy-deploy bundled into the first
outbound UserOperation.

**Done when:** a wallet is created end to end on Base Sepolia on both platforms;
the account is deployed with the WebAuthn validator installed, confirmed by
`isModuleInstalled`; the deployment is bundled into the first send, not a
separate transaction; measured gas for deploy + first UserOp is recorded (open
question 3).

---

## Task 6 — Balance view

Native and ERC-20 balances. Every RPC response parsed with Zod before use.
Explicit loading, empty, and error states with a real recovery action.

**Done when:** balances render correctly on both platforms; a malformed RPC
response produces a handled error state rather than a crash or blank screen, with
a test that feeds deliberately malformed data; there is no code path where an
unparsed RPC response reaches app logic.

---

## Task 7 — Send flow and confirmation screen

The most important screen in the app (Invariant 8). Before any biometric prompt
it shows: amount, recipient, an explicit warning when the address has never been
sent to before, the network fee and which token pays it, and which factors are
required and why.

Gas estimated using `getWebauthnValidatorMockSignature` so the fee is real and on
screen *before* the user is asked for biometrics.

Plain language only — see `CLAUDE.md`'s banned-words list.

**Done when:** the fee shown pre-prompt matches the fee actually charged within a
stated tolerance, tested; the never-sent-before warning triggers correctly, with
tests for both first send and repeat send; a copy review confirms no banned term
appears in any user-facing string, enforced by a test that greps the string
catalogue; a screen-reader pass confirms every interactive element is labelled
and every touch target is at least 44pt; the screen is correct in dark mode and
at the largest dynamic type setting.

---

## Task 8 — Session keys

SmartSessions with `value-limit-policy` and `time-frame-policy`. User-visible
controls for both bounds, in plain language. `sudo-policy` must never be
installable — assert this in code and in a test.

**Done when:** a transaction within bounds succeeds without a fresh biometric
prompt; a transaction exceeding the value bound is rejected **on-chain**, proven
by a test that submits it directly to a bundler bypassing the app entirely; an
expired session is likewise rejected on-chain; a test asserts `sudo-policy` is
never present in any install path.

The bypass test is the important one. It is the difference between "the app
prevents this" and "the account prevents this."

---

## Task 9 — Adversarial paths

Every one of these needs an explicit handled state and a test:

- Expired session key
- Bundler timeout
- Bundler returning malformed data
- Bundler returning a plausible but wrong UserOp hash
- Network drop mid-signature
- App killed mid-transaction
- Clock skew between device and chain
- Proxy unreachable (must still work against a public bundler — §7)
- Deep link and QR payload carrying a hostile address or malformed data
- Rooted/jailbroken device (warn, do not hard-block)

**Done when:** each has a test and a defined user-visible outcome with a real
recovery action; no path produces a blank screen, an unhandled rejection, or a
silent failure; deep links and QR payloads never auto-execute anything.

---

## Task 10 — Test suite

Unit tests (Vitest) on all policy, transaction, and factor logic — no rendering
environment required. Contract tests (Foundry) against a Base Sepolia fork
covering module installation, session bounds, and validator behaviour, including
fuzz tests on every bound. E2E (Maestro or Detox) on both platforms: create
wallet, send within session bounds, send requiring a fresh biometric prompt,
session expiry.

**Done when:** the whole suite passes on both platforms with zero failing and
zero skipped tests; no test is retried to make it pass — any flake is fixed at
the underlying race; coverage of `core/` is meaningful, judged by whether the
adversarial paths in Task 9 are actually exercised rather than by a percentage.

---

## Task 11 — Security self-review

A dedicated pass, not a side effect of the other tasks, hunting specifically for:

- Any path that reaches a state-changing call without the confirmation screen
- Key material in logs, storage, analytics, or crash reports — including dev builds
- Anywhere the proxy gained implicit trust
- Any unparsed external input reaching app logic
- Screenshot exposure on sensitive screens; sensitive state surviving backgrounding

**Done when:** the pass is written up with what was searched for, what was found,
and what was fixed. "Found nothing" is an acceptable outcome only if the write-up
shows what was actually looked at.

**Status: done for the code that exists,** written up in `SECURITY-REVIEW.md`.

One high-severity finding, fixed: an unknown fee could reach the biometric
prompt. `FeeQuote` carried a bare `maxFee`, where `0n` meant both "sponsored"
and "estimate not back yet" — so a screen rendering mid-estimate could clear the
Invariant 8 gate and show a cost that was not real. `FeeQuote` is now a
discriminated union, making "unknown" unrepresentable.

Two findings accepted and deferred with reasons recorded: `Address` is
structural rather than branded (revisit when the app shell lands), and CI
actions are pinned by tag rather than SHA (pin before any workflow holds a
secret).

The UI- and device-dependent hazards — screenshot suppression, backgrounding,
root detection, crash-reporter integration — are listed as not reviewable here
rather than as passes, and must be reviewed again once those layers exist.

---

## Task 12 — Gate deliverable

**Done when all of the following exist:**

- Working build on both iOS and Android
- Full test suite passing, nothing skipped
- `CLAUDE.md`, `ARCHITECTURE.md`, `PHASES.md` updated to match reality
- Every `ARCHITECTURE.md` §9 open question either answered or explicitly still open
- A written summary: what was built, what was deliberately deferred, and what
  remains uncertain — with the Invariant 3 gap restated plainly so it cannot be
  mistaken for finished

**Then stop.** Phase 2 does not begin without explicit approval.

---

# Phases 2–5 — sketch only

Broken into tasks when their turn comes.

**Phase 2 — zkEmail recovery.** Integrate the upstream email-recovery module.
Enroll email at setup as a commitment, never plaintext on-chain. Lost-device
flow: new device → new passkey → email proof → time-locked rotation →
cancellable from the old device. Benchmark on-device proving and decide whether
the default flips (decision 3). Test the cancellation path hardest — it is the
entire defense against email account takeover, and it only works if the user
finds out in time, which is why push notification delivery is part of this phase
rather than a nicety.

**Phase 3 — Risk-adaptive quorum.** The policy module: value- and
destination-based escalation enforced on-chain, user-configurable thresholds,
known-recipient tracking, high-value time delay with passkey-only cancellation.
This is where Invariant 3 finally becomes true, and where the only substantial
custom Solidity in the project lives. Foundry invariant tests proving no
reachable state lets a single factor move funds above the threshold. Plus a
differential test asserting the app's policy mirror agrees with on-chain
evaluation across the fuzzed input space.

**Phase 4 — Anonymous guardians.** Semaphore group enrollment, guardian approval
with a nullifier bound to the specific UserOperation, guardian management UI. The
UI must state plainly that anonymity is strong on-chain but not absolute against
timing and metadata correlation. Do not oversell it.

**Phase 5 — Hardening and scale.** Optimism and Arbitrum, automatic precompile
detection across chains, EIP-7702 activation for users with existing funded EOAs,
performance passes, pre-audit cleanup.

---

## Gate rules

Every gate delivers: a working build on both platforms, a passing suite with
nothing skipped, updated docs, and a written summary covering what was built,
what was deferred, and what is uncertain.

No phase is marked complete with failing, skipped, or flaky tests. No phase
begins before the previous one is approved. If something cannot be tested
properly, say so explicitly rather than marking it done.
