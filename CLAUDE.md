# CLAUDE.md — Blin Vault

Context for any session picking this project up cold. Read this file, then
`ARCHITECTURE.md`, then `PHASES.md`, before touching code.

---

## What this is

**Blin Vault** is a non-custodial mobile smart-contract wallet for *individuals*
(not DAOs, not treasuries) on EVM chains. It replaces the seed phrase with a
threshold policy over factors the user already has: a device passkey, a
zero-knowledge proof of email control, and optionally a group of anonymous
guardians.

The differentiating feature is **risk-adaptive quorum** — the number of factors
required scales with the risk of the transaction, and that policy is enforced in
the account contract, never in the app.

| Transaction | Required |
|---|---|
| Small value, known recipient | Passkey only (via bounded session key) |
| Above low threshold, or new/unknown recipient | Passkey + zkEmail |
| Above high threshold | Passkey + zkEmail + time delay (cancellable by passkey alone) |

Design rationale, threat model, and risk register live in the working paper
(`blin-vault-whitepaper.pdf`, v0.1 Aug 2026). Where this repo and the paper
disagree, this repo is correct and the disagreement is recorded under
[Corrections to the whitepaper](#corrections-to-the-whitepaper).

---

## Current status

**Phase 0 — design documents, awaiting approval. No application code exists yet.**

Nothing has been built. `CLAUDE.md`, `ARCHITECTURE.md`, and `PHASES.md` are the
entire deliverable so far. Phase 1 does not begin until the human approves these
three files.

---

## The invariants

These are the contract. Violating any one is a critical bug regardless of what
else works. They are numbered; refer to them by number in code comments, commit
messages, and review notes.

1. **No seed phrase** is ever generated, displayed, derived, or requested. Not as
   a "backup option," not in an advanced menu, not anywhere.
2. **The provider holds no signer, key share, proof share, or module-upgrade
   authority.** If any code path lets our infrastructure move user funds or
   change the account's security policy, that is both a critical bug and a
   regulatory problem. There is no "support can recover your wallet" path.
3. **No single factor is ever sufficient** to move funds above the low-value
   threshold. Email alone can never move money. A stolen unlocked phone alone can
   never drain the account. *(See [Known gaps](#known-gaps) — this is not yet true
   in Phase 1, by construction.)*
4. **Quorum policy lives on-chain.** The app may mirror the policy to tell the
   user what will be required. The contract is the sole source of truth. A
   client-side policy check is a display convenience and never an enforcement
   mechanism.
5. **Private keys never leave secure hardware.** No key material in JS memory, no
   key material in AsyncStorage, no key material in logs, ever.
6. **Never log, persist, or transmit** raw email contents, DKIM material, private
   keys, session key secrets, Semaphore identity secrets, or full unredacted
   UserOperations containing signatures.
7. **Bundlers and paymasters are transport, not trust.** A hostile bundler must
   be able to censor us, never to forge. Never route through a proprietary
   channel that cannot be swapped out.
8. **Every state-changing on-chain action shows a plain-language confirmation**
   of what it does, what it costs, and which factors it requires — *before* any
   biometric prompt.

---

## Decision log

Answers to the five questions in the master prompt, confirmed by the human on
2026-08-14. A fresh session should treat these as settled and not re-litigate
them.

### 1. Launch chains — Base first

Base Sepolia for all development and testing; Base as the first mainnet target
after external audit. Optimism and Arbitrum in Phase 5.

Reasoning: Base carries RIP-7212, has the deepest bundler/paymaster support, and
is where zkEmail's `email-recovery` module is already live in production (Base
Mainnet and Base Sepolia). Phase 2 therefore lands on an existing audited
deployment rather than a fresh one.

### 2. Account implementation — Safe7579 adapter

Safe singleton plus the Rhinestone/Safe co-developed ERC-7579 adapter, driven
through `permissionless`'s `toSafeSmartAccount` with `erc7579LaunchpadAddress`
set.

Reasoning: the contract holding the funds is the most battle-tested account in
the ecosystem, which is the right bias for individual custody, and zkEmail ships
*both* a universal ERC-7579 module and a native Safe module — two supported
recovery paths instead of one.

Accepted cost: highest gas of the candidates, and the most contracts in the
trust path (Safe singleton + adapter + launchpad + modules). Kernel v3 and Nexus
were the alternatives; both are natively ERC-7579 and cheaper, and both were
rejected in favour of Safe's larger adversarial exposure. Revisit only with a
concrete gas measurement showing the cost is unacceptable.

### 3. zkEmail proving — relayer default, on-device evaluated

Phase 2 uses zkEmail's upstream relayer model, which is the production-proven
path. The relayer endpoint is configurable and self-hostable.

The relayer **sees the email content**. It cannot forge a signature or move
funds, so it is transport under Invariant 7, but it is a genuine *privacy*
boundary and must be described to the user in those words. On-device proving is
to be benchmarked during Phase 2; if the numbers are acceptable the default
flips. Do not promise on-device proving in UI copy or docs before that benchmark
exists.

### 4. Testnet only for Phases 1–3

Confirmed. No mainnet, no real funds, until after external audit. Any chain
config committed before that gate must be testnet.

### 5. Backend — thin stateless proxy only

One unavoidable need: bundler/paymaster API keys must not ship inside the app
binary, where they are trivially extracted and abused. So a stateless proxy that
holds the keys and forwards RPC and bundler calls.

It persists **nothing**. No accounts, no emails, no policy, no key material. The
one permitted piece of state, if push notifications are built, is a table of
`{account address, opaque push token}` and nothing else — needed so a user learns
about a malicious recovery attempt while the time-lock is still running, which is
what makes the Phase 2 cancellation defense real.

Recipient-book sync was considered and rejected: it would teach the server the
user's counterparties, and Phase 3 needs known-recipient tracking on-chain for
enforcement anyway.

---

## Known gaps

Written down because they are easy to misread as finished.

**Phase 1 does not satisfy Invariant 3.** With only a passkey validator
installed, the passkey *is* a single sufficient factor for any amount. Session
key bounds limit an unattended session; they do not limit the passkey itself.
Invariant 3 becomes true in Phase 3, when the policy module lands. Until then,
Phase 1 must not be described — in docs, UI copy, or a demo — as delivering the
threshold security property. It delivers the *foundation* for it.

**Phase 3 is where the custom Solidity lives.** Phases 1 and 2 are almost
entirely audited upstream modules. The risk-adaptive policy module has no
upstream equivalent and is genuinely new code in the validation path. It is the
piece that most needs audit attention and the most adversarial testing.

---

## Corrections to the whitepaper

The paper is v0.1 and two of its factual claims are now out of date. Follow this
file, not the paper, on these points.

1. **§2.2 says the mainnet P-256 precompile "remains undeployed as of mid-2026."
   This is wrong.** EIP-7951 is Final and shipped with the Fusaka upgrade on
   Ethereum mainnet (2025-12-03), at address `0x100`, costing 6900 gas. It
   deliberately differs from RIP-7212 by requiring a point-at-infinity check and
   comparing `r' ≡ r (mod n)` rather than `r' == r`.

   Consequence: there are three cases to detect at runtime, not two — EIP-7951,
   RIP-7212, and Solidity fallback. RIP-7212 and EIP-7951 occupy **the same
   address with identical input/output**, so they cannot be told apart by address.
   See `ARCHITECTURE.md` for the detection rule and the trap it avoids.

2. **§3.3 and §8 are in tension about when policy enforcement exists.** The
   roadmap puts the policy module in Phase 3, but §3.3 describes on-chain policy
   enforcement as though it were present throughout. It is not present in Phases
   1–2. See [Known gaps](#known-gaps).

---

## Conventions

**TypeScript.** Strict mode. No `any`. No non-null assertions on external data.
Every external input — RPC response, bundler response, deep link, QR payload — is
parsed with Zod at the boundary before it reaches app logic.

**Errors.** Every one handled explicitly. No empty catch blocks, no swallowed
rejections. If a failure mode is genuinely unreachable, assert loudly rather than
ignore.

**Structure.** Business logic lives in pure modules, separate from React
components. Policy evaluation, transaction construction, and factor
orchestration must all be unit-testable with no rendering environment.

**Comments.** Explain *why*, not *what*. Any cryptographic or policy code gets a
comment naming the security property it protects and what breaks if it changes.
Reference invariants by number.

**Dependencies.** Pinned exactly — no `^`, no `~`. Anything new gets justified in
the commit message. Prefer fewer, well-maintained packages.

**Secrets.** None in the repo. Config via environment. Commit `.env.example` and
nothing else.

**Commits.** Conventional commits, one logical change each.

---

## User-facing language

The security model is only as good as the user's understanding of it, so treat
copy as a security surface.

**Never appear in user-facing text:** multisig, quorum, M-of-N, validator,
UserOperation, bundler, paymaster, nonce, calldata, gas (prefer "network fee"),
seed phrase, private key.

**Say what is actually happening instead.** "This transfer needs your fingerprint
and an email confirmation." "This is larger than your usual transfer, so we'll
also confirm by email." Every screen should make sense to someone who has never
used crypto.

The confirmation screen is the most important screen in the app. Before any
biometric prompt it must show: amount, recipient with an explicit warning when
the address has never been sent to before, the network fee and which token pays
it, and exactly which factors are required and why (Invariant 8).

---

## Commands

These exist and pass:

```
pnpm install     # install workspace dependencies
pnpm typecheck   # tsc --noEmit, strict, must be clean
pnpm lint        # eslint incl. core/-purity rule, must be clean
pnpm test        # vitest unit tests
```

Not yet scaffolded, because this environment cannot build or run them (see
[Environment limits](#environment-limits)):

```
pnpm ios / pnpm android          # Expo dev client — needs macOS/Xcode, Android SDK
forge test                       # contracts — Foundry not installable here
forge test --match-test invariant
```

**Toolchain note.** TypeScript is pinned to 6.0.3 rather than the current 7.0.2
because `typescript-eslint@8.67.0` declares `typescript >=4.8.4 <6.1.0`. Type-aware
linting is load-bearing here — it is what enforces `no-floating-promises` and the
`core/` purity rule — so it wins over the newer compiler. Revisit when
typescript-eslint supports TS 7.

---

## Environment limits

The container this project has been developed in so far is Linux with Node and
pnpm only. The following are **not** available, which caps how much of Phase 1
can be completed or verified here:

| Blocked | Consequence |
|---|---|
| No macOS/Xcode, no Android SDK, no devices or emulators | Cannot build, run, or E2E-test the app. Phase 1 Tasks 2, 5, 6, 7 (UI), 10 (E2E), 12 cannot be completed |
| Egress policy blocks RPC endpoints (`sepolia.base.org` → 403) | Cannot verify anything against a live chain: deployed module addresses, counterfactual addresses, real bundler behaviour, real gas |
| Egress policy blocks Foundry install and GitHub releases (403) | No `forge`, no `anvil`, so no Solidity contract tests |

`registry.npmjs.org` **is** reachable, which matters more than it sounds.

**A real EVM is available here** via `@ethereumjs/evm`, installed from npm. It
supports both the `Prague` and `Osaka` hardforks, so the EIP-7951 precompile at
`0x100` can be exercised present *and* absent. `p256.evm.test.ts` uses this to
demonstrate — rather than assert — that a CALL to an empty `0x100` succeeds
with empty returndata and zero gas, and that the precompile charges exactly
6900 gas. That closes the most important open question in Task 3 without a live
chain.

What a real EVM does **not** substitute for: deployed contract addresses, real
bundler and paymaster behaviour, mainnet-fork state, and Solidity-level tests
(which need Foundry). Do not mark those done on the strength of unit tests
against mocks.

---

## Rules for working on this repo

**Build one phase at a time and stop at the gate.** Phases are defined in
`PHASES.md`. Do not start Phase N+1 because Phase N looks finished. Money is at
stake and large uninspected diffs are how funds get lost.

**Never invent cryptography.** Every cryptographic primitive comes from an
audited, production-deployed upstream library. If you find yourself writing a
signature verifier, a circuit, or a proof aggregator from scratch — stop and say
so instead.

**Never fabricate a library API.** If unsure whether a function exists, check the
installed package or the docs first. A confidently wrong API call in wallet code
is worse than an admitted gap. The verified API surface as of 2026-08-14 is
recorded in `ARCHITECTURE.md`.

**Say when something is untested.** An honest "this part isn't ready" is worth
more than a polished demo that loses someone's money. Never mark a phase complete
with failing, skipped, or flaky tests — if a test is flaky, fix the underlying
race rather than retrying it.

**Stop and ask** when a security decision has a real tradeoff, when an upstream
library does not do what is needed, when something cannot be tested properly, or
when this repo conflicts with the whitepaper or with the actual libraries. Flag
the conflict; do not guess which side wins.

**Before every phase gate**, do a self-review pass hunting specifically for:
paths that bypass on-chain policy, key material reaching logs or storage, and any
place the backend gained implicit trust.

---

## Anti-patterns

- Custom cryptographic primitives, circuits, or signature verifiers
- Any recovery key or escrow held by us, in any form, for any reason
- Enforcing security policy in the app instead of the contract
- Key material, proofs, or email content in AsyncStorage, logs, or analytics
- `console.log` of anything sensitive, including in dev builds
- Silent failures, empty catch blocks, errors surfaced as blank screens
- Building multiple phases at once, or skipping a gate
- Marking work complete with failing, skipped, or flaky tests
- Crypto jargon in user-facing copy
- Hardcoding chain-specific behaviour instead of detecting capability at runtime
- Claiming something is audited or production-safe when it is not

---

## A note on "perfect"

The brief asked for this to be built "perfectly, without bugs." No process
guarantees a bug-free wallet, and any claim otherwise is selling something. What
is achievable is making bugs *unlikely, contained, and catchable*: audited
primitives instead of homemade ones, on-chain enforcement instead of client-side
trust, small reviewable phases instead of one giant diff, adversarial tests
instead of happy-path ones, and honest reporting of uncertainty instead of
confident guessing.

This code must be independently audited before it touches real funds. Build like
that audit is happening, because it is.
