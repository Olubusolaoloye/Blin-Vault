/**
 * Which JSON-RPC methods the proxy will forward.
 *
 * An ALLOWLIST, not a denylist. The proxy exists to hold provider API keys that
 * must not ship in the app binary (ARCHITECTURE.md §7); it is not a general
 * gateway to the chain. Anything not needed by the wallet is refused, so a
 * compromised or curious client cannot use our keys as an open RPC endpoint,
 * and adding a capability is a reviewed decision rather than an oversight.
 */

/** Chain reads the wallet needs. */
const READ_METHODS = [
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBalance',
  'eth_call',
  'eth_estimateGas',
  'eth_getCode',
  'eth_getTransactionCount',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getBlockByNumber',
  'eth_getLogs',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
] as const

/** ERC-4337 bundler methods. */
const BUNDLER_METHODS = [
  'eth_sendUserOperation',
  'eth_estimateUserOperationGas',
  'eth_getUserOperationByHash',
  'eth_getUserOperationReceipt',
  'eth_supportedEntryPoints',
] as const

export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  ...READ_METHODS,
  ...BUNDLER_METHODS,
])

/**
 * Methods that must never be forwarded, listed explicitly for the reader.
 *
 * WHY THIS EXISTS when an allowlist already excludes them: Invariant 2 says the
 * provider holds no signer. These are the methods that would imply otherwise.
 * Upstream would reject them anyway — the proxy has no accounts — but
 * forwarding them at all would make the proxy *look* like a signing service to
 * a confused client, and the shape of an interface teaches people what it is
 * for. Refusing them here states the boundary rather than leaving it implied.
 *
 * This set is documentation and a test fixture. The allowlist is the control.
 */
export const NEVER_FORWARDED: ReadonlySet<string> = new Set([
  'eth_accounts',
  'eth_requestAccounts',
  'eth_sendTransaction',
  'eth_sign',
  'eth_signTransaction',
  'eth_signTypedData',
  'eth_signTypedData_v4',
  'personal_sign',
  'personal_unlockAccount',
  'wallet_addEthereumChain',
])

export function isMethodAllowed(method: string): boolean {
  return ALLOWED_METHODS.has(method)
}
