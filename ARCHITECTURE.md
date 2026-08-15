# ARCHITECTURE.md — Blin Vault

Chosen stack with justifications, module structure, the on-chain/off-chain
boundary, and where each security property is enforced.

Everything in the "verified" column below was checked against the actual
published package or specification on **2026-08-14**, not recalled from memory.
Anything not verified is marked as such.

---

## 1. Stack

| Layer | Choice | Version (verified 2026-08-14) | Why |
|---|---|---|---|
| App | React Native + TypeScript strict, Expo with dev client | — | Native modules required for passkeys, so Expo Go is not viable |
| Chain | `viem` | 2.55.16 | Standard, typed, Zod-friendly |
| ERC-4337 | `permissionless` | 0.3.7 | Do not hand-roll UserOperation construction |
| Modules | `@rhinestone/module-sdk` | 0.4.0 | Audited module registry; ships every module we need |
| Account | Safe + Safe7579 adapter | via `toSafeSmartAccount` | See §2 |
| Passkeys | `react-native-passkey` | 3.6.1 | Actively maintained; iOS 15+/Android API 28+ |
| Recovery (Ph2) | `@zk-email/email-recovery` | 1.1.0 | Ackee-audited, live on Base |
| Guardians (Ph4) | `@semaphore-protocol/core` | 4.14.3 | Audited verifier contracts |
| State | Zustand | 5.0.15 | No secrets in persisted state, ever |
| Validation | Zod | 4.4.3 | Every external input parsed at the boundary |
| Contracts | Foundry | — | Fuzz + invariant tests |

`react-native-passkeys` (0.4.2, Expo module) is the fallback candidate if
`react-native-passkey` proves unworkable under Expo dev client. Decide in Phase 1
Task 2 with a working spike, not on reputation.

---

## 2. Account: Safe + Safe7579

**Trust path for a user's funds:**

```
EntryPoint (ERC-4337 v0.7)
  └─ Safe singleton 1.4.1          ← holds the funds
       └─ Safe7579 adapter          ← makes the Safe speak ERC-7579
            └─ Safe7579 launchpad   ← counterfactual deploy + module init
                 ├─ WebAuthn validator   (Phase 1)
                 ├─ SmartSessions         (Phase 1)
                 ├─ Email recovery module (Phase 2)
                 ├─ Policy module         (Phase 3 — our code)
                 └─ Semaphore guardian validator (Phase 4)
```

Every box except the Phase 3 policy module is audited upstream code we do not
write. That distribution is the whole point of the choice.

**Verified API surface.** `toSafeSmartAccount` in `permissionless@0.3.7`
(`permissionless/accounts`) accepts `safeSingletonAddress`,
`safe4337ModuleAddress`, `erc7579LaunchpadAddress`, `attesters`, and
`attestersThreshold`. Module lifecycle actions — `installModule`,
`uninstallModule`, `isModuleInstalled`, `supportsModule`,
`supportsExecutionMode`, `accountId` — come from `permissionless/actions/erc7579`.
Confirmed by unpacking the published tarball and reading the emitted `.d.ts`.

**`attesters` / `attestersThreshold` matter for Invariant 2.** They configure
which attestations the Rhinestone registry requires before a module may be
installed. Set them deliberately in Phase 1 and document the choice — a permissive
setting widens what can be installed into the validation path.

**Deployment.** Counterfactual via CREATE2, so the address is displayable and
fundable before it exists on-chain. Deployment is bundled into the first
outbound UserOperation.

**Rejected alternatives.** ZeroDev Kernel v3 (natively 7579, cheapest gas, ~900k
accounts, RN passkey example available) and Biconomy Nexus (natively 7579,
audited by Cyfrin and Spearbit). Both are good and both are cheaper. Safe wins
on adversarial exposure of the contract that actually holds the money, and on
zkEmail supporting Safe through two independent paths. Revisit only against a
real gas measurement.

---

## 3. P-256 verification — three cases, one address

This is the subtlest part of Phase 1. Get it wrong and the failure is silent.

| Case | Address | Gas | Notes |
|---|---|---|---|
| EIP-7951 | `0x100` | 6900 | Final; mainnet since Fusaka, 2025-12-03 |
| RIP-7212 | `0x100` | 3450 | Base, Optimism, Arbitrum, Polygon, zkSync |
| Neither | — | ~300k | Audited Solidity fallback (FreshCryptoLib-derived / Daimo) |

Both precompiles take the same 160-byte input (`hash ‖ r ‖ s ‖ x ‖ y`) and both
return 32-byte `1` on success and **empty output on failure**. They differ only
in gas and in two edge cases: EIP-7951 requires a point-at-infinity check and
compares `r' ≡ r (mod n)` instead of `r' == r`.

**The trap.** Since they share an address, they cannot be distinguished by
address. Worse: on a chain with neither, `0x100` is an *empty account*, and a
`CALL` to an empty account **succeeds and returns empty data** — which is exactly
what RIP-7212 returns for "this signature is invalid."

Two ways to get this catastrophically wrong:

- Treat "call succeeded" as "signature valid" → the verifier accepts every
  signature on any chain lacking the precompile. Total compromise.
- Treat "empty returndata" as "precompile absent" → the verifier silently falls
  back on every genuinely-invalid signature, which is merely wasteful, but masks
  the first bug in testing.

**The rule.** Detect by *behaviour*, never by address or call status. Probe
`0x100` with a known-good test vector and require the exact 32-byte `1`. Only
then treat the precompile as present. Cache the result per chain ID. Gas
estimation must use the correct constant, since 3450 and 6900 are both real
and a strategy chosen for the wrong one under-quotes the fee.

**Client-side interaction.** `@rhinestone/module-sdk`'s
`WebauthnValidatorSignature` type carries a `usePrecompiled?: boolean` flag, so
the *client* tells the on-chain validator which path to take at signature time.
Our chain-capability detection feeds that flag. This is a correctness-critical
input from an untrusted-ish source and must be derived from the probe result for
the target chain, never hardcoded and never taken from a config the user or a
deep link can influence.

---

## 4. Modules

Verified present in `@rhinestone/module-sdk@0.4.0` by reading the unpacked
package.

**Phase 1 — `webauthn-validator`.** Exports `getWebAuthnValidator`,
`getWebauthnValidatorSignature`, `getWebauthnValidatorMockSignature`, and
`WEBAUTHN_VALIDATOR_ADDRESS`. Installation encodes `{pubKeyX, pubKeyY}` plus
`keccak256(authenticatorId)`. The mock-signature helper is what makes honest gas
estimation possible before the user is prompted for biometrics — needed for
Invariant 8, since the fee must be on screen *before* the Face ID prompt.

**Phase 1 — `smart-sessions`.** Ships composable policies:
`value-limit-policy`, `time-frame-policy`, `usage-limit-policy`,
`spending-limits-policy`, `universal-action-policy`, `sudo-policy`. The brief's
"session keys with value/time bounds" is `value-limit-policy` +
`time-frame-policy` — audited upstream, not our code. **Never install
`sudo-policy`**; it is an unbounded session and defeats the entire purpose.

**Phase 2 — `zk-email-recovery`,** with
`UNIVERSAL_EMAIL_RECOVERY_ADDRESS` exported from the SDK constants.

**Phase 3 — the policy module is ours.** `multi-factor-validator` exists upstream
and covers "require N of these validators," but nothing upstream covers
"*which* validators are required is a function of transaction value and
destination novelty." That function is the product. It is new code in the
validation path, and it is the single highest-risk artifact in the project.

**Phase 4 — Semaphore.** Guardian group validator with nullifier binding.

---

## 5. Where each security property is enforced

The central question of this document. "App" means it can be bypassed by a
malicious client; "Contract" means it cannot.

| Property | Enforced | From |
|---|---|---|
| Passkey signature is valid | **Contract** — WebAuthn validator | Phase 1 |
| Session key value ceiling | **Contract** — `value-limit-policy` | Phase 1 |
| Session key expiry | **Contract** — `time-frame-policy` | Phase 1 |
| Which factors a transaction needs | **Contract** — policy module | Phase 3 |
| Recipient is novel → escalate | **Contract** — policy module | Phase 3 |
| High-value time delay | **Contract** — policy module | Phase 3 |
| Recovery time-lock + cancellation | **Contract** — recovery executor | Phase 2 |
| Email controls the registered address | **Contract** — zkEmail verifier + DKIM registry | Phase 2 |
| Guardian is a real group member | **Contract** — Semaphore verifier | Phase 4 |
| Proof/approval cannot be replayed | **Contract** — nullifier bound to UserOp hash | Phases 2, 4 |
| Module installation requires quorum | **Contract** — account's own validation | Phase 3 |
| User sees what they are approving | **App** — confirmation screen | Phase 1 |
| Factor requirements shown pre-prompt | **App** — mirrors contract policy | Phase 1 |
| Biometric gate on passkey use | **OS** — Secure Enclave / StrongBox | Phase 1 |

Everything in the App row is a **display convenience**. The app's policy
evaluation exists so the user is told the truth in advance; it is never the thing
that stops a transaction. If the app's mirror and the contract ever disagree, the
contract wins and the app has a bug — Phase 3 needs a differential test asserting
the mirror matches on-chain evaluation across the fuzzed input space.

---

## 6. On-chain / off-chain boundary

**On-chain:** the account, all validators, all policy state (thresholds, known
recipients, time-locks), the email commitment (a hash — never the address), and
guardian identity commitments.

**On device, in secure hardware:** the P-256 private key. Never extractable,
never in JS memory (Invariant 5).

**On device, in plain storage:** account address, chain config, cached balances,
UI preferences, and the local mirror of policy thresholds. All of it
non-sensitive and all of it reconstructible from chain state. Nothing here is
authoritative.

**Never persisted anywhere:** raw email content, DKIM material, session key
secrets, Semaphore identity secrets, and full UserOperations with signatures
attached (Invariant 6).

**The proxy** (see §7) is stateless and holds no user data.

---

## 7. Backend: thin stateless proxy

Exists for exactly one reason: bundler and paymaster API keys must not ship in
the app binary, where they are extracted and abused within days.

**It does:** hold provider API keys, forward RPC and bundler calls, enforce rate
limits, and fail over between at least two configured providers.

**It knows:** nothing persistent. Optionally, if push notifications are built,
`{account address, opaque push token}` and nothing else — needed so a user learns
about a malicious recovery attempt while the Phase 2 time-lock is still running.
Without that channel, the cancellation defense only works if the victim happens
to open the app, which is a weak assumption for the attack it is meant to stop.

**It must never:** hold a signer, key share, or proof share; see raw email
content; be able to alter policy; or be required for a transaction to be valid.
A user must be able to point the app at a public bundler and transact with the
proxy entirely offline. That property is what makes Invariant 2 and Invariant 7
true rather than aspirational, and it should be an explicit test — "works with
proxy unreachable" — not an assumption.

**Implemented** in `services/proxy/`. Three properties are enforced in code and
tested rather than documented and hoped for:

- **Method allowlist, not denylist.** The proxy forwards the chain reads and
  ERC-4337 methods the wallet needs, and nothing else, so a compromised client
  cannot use our keys as an open RPC endpoint. Signing methods are refused
  without contacting an upstream — upstream would reject them anyway, but
  forwarding them would make the proxy *look* like a signing service, and the
  shape of an interface teaches people what it is for (Invariant 2).
- **No upstream error text reaches a client.** Provider keys live in URLs,
  upstream errors quote the request URL, and the error path is the least
  exercised in testing — so relaying an upstream failure verbatim is the easiest
  way to hand a client the key the proxy exists to hide. Clients get a generic
  failure; operators read their own logs. Tested by feeding the handler an
  exception containing a live-looking key and asserting it cannot be found
  anywhere in the response.
- **Statelessness is tested, not asserted.** No health cache and no circuit
  breaker, so a failing upstream is not remembered between requests and one
  request's outcome never depends on another's.

The HTTP binding adds the checks about requests that never reach the handler:
POST-only on one path, no CORS headers (this endpoint serves our app, not a
browser origin, and emitting them would let a hostile page spend our API
quota), and a body cap enforced *during* streaming rather than after buffering —
a limit applied once the memory is already committed is not a limit.
X-Forwarded-For is deliberately ignored when identifying a caller, since it is
client-controlled and honouring it would let an attacker mint a fresh identity
per request. These are tested against a real bound socket, because streaming
caps and destroyed sockets do not exist in a mocked request object.

Rate limiting is the one place the proxy remembers anything, and
`rateLimit.ts` states that tension rather than hiding it: keyed on a transport
identifier only and never on an account, in memory only, expiring with the
window, and bounded — an unbounded map keyed by an attacker-controlled value is
itself a denial-of-service vector. The bound brings an accepted weakness, which
is documented and pinned by a test rather than left to be discovered.

Still to build before the proxy is deployable: TLS termination and deployment
config, and certificate pinning at the app end.

Certificate-pin RPC and bundler connections. Treat every response as untrusted
and parse it with Zod before use, including responses from our own proxy.

---

## 8. App module structure

Business logic is pure and testable without a renderer.

```
apps/mobile/src/
  core/
    chain/       chain configs, P-256 capability probe + cache
    account/     account construction, counterfactual address, deployment
    passkey/     WebAuthn wrapper, biometric gate
    session/     session key creation, bounds, expiry
    tx/          UserOperation construction, gas estimation
    policy/      client-side mirror of on-chain policy — display only
    validation/  Zod schemas for every external boundary
  ui/            screens and components — no business logic
  state/         Zustand stores — no secrets, ever
packages/
  contracts/     Foundry: policy module (Phase 3), tests, deploy scripts
services/
  proxy/         stateless key-holding proxy
```

The `core/` tree must have no React imports. That is a lint rule, not a
convention — it is what keeps policy and transaction logic unit-testable and
reviewable in isolation.

---

## 9. Open questions

Recorded rather than guessed.

1. **Are the Rhinestone module addresses identical across Base Sepolia and Base
   mainnet?** The SDK exports single constants, which implies deterministic
   deployment, but this must be verified on-chain in Phase 1 Task 3 before any
   address is hardcoded.
2. **Does `react-native-passkey@3.6.1` work under Expo dev client on both
   platforms without patching?** Assume nothing; Phase 1 Task 2 is a spike.
3. **Real gas cost of a Safe7579 deployment + first UserOp on Base.** Needed to
   confirm the Safe choice was right. Measure, do not estimate.
4. **Whether the Safe7579 launchpad flow and `permissionless@0.3.7` agree on the
   current adapter version.** The published Pimlico guides reference
   `permissionless@^0.2`; we are on 0.3.7. Verify against the installed package
   rather than the docs site.
5. **zkEmail relayer availability and rate limits on Base Sepolia** — Phase 2, but
   worth confirming early since it shapes the recovery UX.

---

## 10. Deliberately not decided yet

EIP-7702 activation (Phase 5), additional chains (Phase 5), ERC-20 paymaster
token selection (needs the Base decision to be final), and the on-device proving
question (Phase 2, pending benchmark). None of these should be designed for
speculatively now.
