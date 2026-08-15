/**
 * Chain registry.
 *
 * Decision 4 (CLAUDE.md): testnet only, no mainnet and no real funds, until
 * after external audit. That decision is enforced by a test over this registry
 * rather than left to reviewer vigilance — adding a mainnet entry fails CI.
 */

export interface ChainConfig {
  readonly id: number
  readonly name: string
  /** Plain-language name for user-facing copy. No chain IDs in the UI. */
  readonly displayName: string
  readonly isTestnet: boolean
  /** Fallback public RPC, used when the proxy (ARCHITECTURE.md §7) is unreachable. */
  readonly publicRpcUrl: string
  readonly nativeCurrency: {
    readonly symbol: string
    readonly decimals: number
  }
}

export const BASE_SEPOLIA: ChainConfig = {
  id: 84532,
  name: 'base-sepolia',
  displayName: 'Base test network',
  isTestnet: true,
  publicRpcUrl: 'https://sepolia.base.org',
  nativeCurrency: { symbol: 'ETH', decimals: 18 },
}

/**
 * Every chain the app may target.
 *
 * Base first, Optimism and Arbitrum in Phase 5 (decision 1). Mainnet entries do
 * not belong here until the audit gate has been passed.
 */
export const SUPPORTED_CHAINS: readonly ChainConfig[] = [BASE_SEPOLIA]

export const DEFAULT_CHAIN: ChainConfig = BASE_SEPOLIA

export class UnknownChainError extends Error {
  override readonly name = 'UnknownChainError'
  readonly chainId: number

  /**
   * Written as an explicit field rather than a TypeScript parameter property:
   * parameter properties are a TS-only construct that emits code, so they do
   * not survive type-stripping (Node's `--experimental-strip-types`, and
   * strip-only transforms generally). Keeping the source strippable means
   * tooling can run these modules without a full compile.
   */
  constructor(chainId: number) {
    super(`Chain ${String(chainId)} is not in the supported set.`)
    this.chainId = chainId
  }
}

/**
 * Look up a chain by id.
 *
 * Throws rather than returning undefined: an unrecognised chain id reaching
 * this function means something upstream (a deep link, a stored preference, a
 * bundler response) supplied a value we never registered, and silently falling
 * back to a default chain would risk constructing a transaction for a network
 * the user did not choose.
 */
export function getChainConfig(chainId: number): ChainConfig {
  const chain = SUPPORTED_CHAINS.find((candidate) => candidate.id === chainId)
  if (chain === undefined) throw new UnknownChainError(chainId)
  return chain
}
