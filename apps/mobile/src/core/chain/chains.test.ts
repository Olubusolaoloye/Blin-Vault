import { describe, expect, it } from 'vitest'
import {
  BASE_SEPOLIA,
  DEFAULT_CHAIN,
  getChainConfig,
  SUPPORTED_CHAINS,
  UnknownChainError,
} from './chains.js'

describe('registry', () => {
  /**
   * Decision 4: testnet only until after external audit. This is the
   * enforcement of that decision — adding a mainnet chain fails here rather
   * than depending on someone noticing during review.
   */
  it('contains only testnets', () => {
    const mainnets = SUPPORTED_CHAINS.filter((chain) => !chain.isTestnet)
    expect(mainnets).toEqual([])
  })

  it('defaults to a testnet', () => {
    expect(DEFAULT_CHAIN.isTestnet).toBe(true)
  })

  it('has no duplicate chain ids', () => {
    const ids = SUPPORTED_CHAINS.map((chain) => chain.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every chain a display name free of chain ids', () => {
    for (const chain of SUPPORTED_CHAINS) {
      expect(chain.displayName).not.toMatch(/\d{3,}/)
    }
  })
})

describe('getChainConfig', () => {
  it('resolves a registered chain', () => {
    expect(getChainConfig(84532)).toEqual(BASE_SEPOLIA)
  })

  /**
   * An unregistered id means untrusted input reached us. Falling back to a
   * default would risk building a transaction for a network the user never
   * chose, so this throws.
   */
  it('throws on an unregistered chain rather than falling back', () => {
    expect(() => getChainConfig(1)).toThrow(UnknownChainError)
  })

  it('reports the offending chain id on the error', () => {
    try {
      getChainConfig(999)
      expect.unreachable('expected getChainConfig to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownChainError)
      expect((error as UnknownChainError).chainId).toBe(999)
    }
  })
})
