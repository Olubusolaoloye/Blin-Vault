import { describe, expect, it } from 'vitest'
import { AddressSchema } from '../validation/primitives.js'
import {
  buildTransferConfirmation,
  canPromptForBiometrics,
  classifyRecipient,
  InvalidTransferError,
  requiredFactorsFor,
  shouldWarnAboutRecipient,
  type FeeQuote,
  type KnownRecipients,
  type TokenRef,
  type TransferIntent,
} from './confirmation.js'

const ALICE = AddressSchema.parse('0x6c8b714529b0fe3920152432ac6e7d85f5b6e7a2')
const BOB = AddressSchema.parse('0x799318de96e2ccb47fd2e61aaf61a3951c3d338e')

const ETH: TokenRef = { kind: 'native', symbol: 'ETH', decimals: 18 }

const FEE: FeeQuote = { maxFee: 21_000n, token: ETH }

function knownRecipients(...addresses: readonly string[]): KnownRecipients {
  const set = new Set(addresses)
  return { has: (address) => set.has(address) }
}

function intentTo(to: typeof ALICE, amount = 1_000n): TransferIntent {
  return { to, amount, token: ETH, chainId: 84532 }
}

describe('classifyRecipient', () => {
  it('reports a previously used address as known', () => {
    expect(classifyRecipient(ALICE, knownRecipients(ALICE))).toBe('known')
  })

  it('reports an unseen address as first-time', () => {
    expect(classifyRecipient(BOB, knownRecipients(ALICE))).toBe('first-time')
  })

  it('treats an empty history as first-time', () => {
    expect(classifyRecipient(ALICE, knownRecipients())).toBe('first-time')
  })
})

describe('buildTransferConfirmation', () => {
  it('carries every field the user must see', () => {
    const confirmation = buildTransferConfirmation({
      intent: intentTo(ALICE),
      fee: FEE,
      knownRecipients: knownRecipients(ALICE),
    })

    // Invariant 8: amount, recipient, fee and its paying token, and factors.
    expect(confirmation.intent.amount).toBe(1_000n)
    expect(confirmation.intent.to).toBe(ALICE)
    expect(confirmation.fee.maxFee).toBe(21_000n)
    expect(confirmation.fee.token.symbol).toBe('ETH')
    expect(confirmation.required.factors).toEqual(['passkey'])
  })

  it('flags a first-time recipient', () => {
    const confirmation = buildTransferConfirmation({
      intent: intentTo(BOB),
      fee: FEE,
      knownRecipients: knownRecipients(ALICE),
    })

    expect(confirmation.recipient).toBe('first-time')
    expect(shouldWarnAboutRecipient(confirmation)).toBe(true)
  })

  it('does not flag a repeat recipient', () => {
    const confirmation = buildTransferConfirmation({
      intent: intentTo(ALICE),
      fee: FEE,
      knownRecipients: knownRecipients(ALICE),
    })

    expect(confirmation.recipient).toBe('known')
    expect(shouldWarnAboutRecipient(confirmation)).toBe(false)
  })

  it('records which token pays the fee even when it differs from the token sent', () => {
    const usdc: TokenRef = { kind: 'erc20', address: BOB, symbol: 'USDC', decimals: 6 }
    const confirmation = buildTransferConfirmation({
      intent: { to: ALICE, amount: 5n, token: ETH, chainId: 84532 },
      fee: { maxFee: 1_500n, token: usdc },
      knownRecipients: knownRecipients(),
    })

    expect(confirmation.intent.token.symbol).toBe('ETH')
    expect(confirmation.fee.token.symbol).toBe('USDC')
  })

  it.each([
    ['zero', 0n],
    ['negative', -1n],
  ])('refuses to build a confirmation for a %s amount', (_label, amount) => {
    expect(() =>
      buildTransferConfirmation({
        intent: intentTo(ALICE, amount),
        fee: FEE,
        knownRecipients: knownRecipients(),
      }),
    ).toThrow(InvalidTransferError)
  })

  it('refuses a negative fee quote', () => {
    expect(() =>
      buildTransferConfirmation({
        intent: intentTo(ALICE),
        fee: { maxFee: -1n, token: ETH },
        knownRecipients: knownRecipients(),
      }),
    ).toThrow(InvalidTransferError)
  })

  it('accepts a zero fee, which a sponsoring paymaster produces', () => {
    const confirmation = buildTransferConfirmation({
      intent: intentTo(ALICE),
      fee: { maxFee: 0n, token: ETH },
      knownRecipients: knownRecipients(),
    })
    expect(confirmation.fee.maxFee).toBe(0n)
  })
})

describe('canPromptForBiometrics — the Invariant 8 gate', () => {
  const confirmation = buildTransferConfirmation({
    intent: intentTo(ALICE),
    fee: FEE,
    knownRecipients: knownRecipients(ALICE),
  })

  it('permits the prompt once a complete confirmation exists', () => {
    expect(canPromptForBiometrics(confirmation)).toBe(true)
  })

  /**
   * The failure this guards against: a screen that opens Face ID while the fee
   * is still resolving, so the user approves a cost they never saw.
   */
  it('refuses when there is no confirmation at all', () => {
    expect(canPromptForBiometrics(null)).toBe(false)
  })

  it('refuses when no factors are required, which would mean nothing authorises this', () => {
    expect(
      canPromptForBiometrics({ ...confirmation, required: { ...confirmation.required, factors: [] } }),
    ).toBe(false)
  })

  it('refuses a zero-amount confirmation even if one were constructed', () => {
    expect(
      canPromptForBiometrics({ ...confirmation, intent: { ...confirmation.intent, amount: 0n } }),
    ).toBe(false)
  })
})

describe('requiredFactorsFor', () => {
  /**
   * Phase 1 is passkey-only by construction, so the passkey is a single
   * sufficient factor for any amount. This test documents that gap rather than
   * hiding it: it should CHANGE in Phase 3, when escalation lands on-chain.
   */
  it('requires passkey alone at every value in Phase 1', () => {
    for (const amount of [1n, 10n ** 18n, 10n ** 30n]) {
      expect(requiredFactorsFor(intentTo(ALICE, amount)).factors).toEqual(['passkey'])
    }
  })

  it('reports why, as a code rather than user-facing copy', () => {
    expect(requiredFactorsFor(intentTo(ALICE)).reason).toBe('passkey-only-account')
  })
})
