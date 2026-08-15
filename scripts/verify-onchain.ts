/**
 * On-chain verification of the assumptions Phase 1 rests on.
 *
 * Deliberately a script and NOT part of `pnpm test`. The unit suite must stay
 * hermetic — a test that reaches the network is a test that fails when a
 * provider hiccups, and CLAUDE.md is explicit that a flaky test gets its race
 * fixed rather than retried. CI also runs without the RPC allowlist this needs.
 *
 * So this is run on demand, and its output is evidence recorded in
 * ARCHITECTURE.md rather than a gate that turns red for reasons unrelated to
 * the code.
 *
 * Run with:
 *   NODE_USE_ENV_PROXY=1 pnpm verify:onchain
 *
 * NODE_USE_ENV_PROXY is required because Node's built-in fetch — which viem
 * uses — does not read HTTPS_PROXY on its own.
 */

import { createPublicClient, http, type Address } from 'viem'
import { GLOBAL_CONSTANTS } from '@rhinestone/module-sdk'
import { BASE_SEPOLIA } from '../apps/mobile/src/core/chain/chains.ts'
import {
  detectP256Strategy,
  P256_PRECOMPILE_ADDRESS,
  P256_PROBE_CALLDATA,
  P256_VALID_OUTPUT,
} from '../apps/mobile/src/core/chain/p256.ts'

const MODULES = [
  'WEBAUTHN_VALIDATOR_ADDRESS',
  'SMART_SESSIONS_ADDRESS',
  'VALUE_LIMIT_POLICY_ADDRESS',
  'TIME_FRAME_POLICY_ADDRESS',
  'SUDO_POLICY_ADDRESS',
  'UNIVERSAL_EMAIL_RECOVERY_ADDRESS',
  'REGISTRY_ADDRESS',
  'MULTI_FACTOR_VALIDATOR_ADDRESS',
] as const

async function main(): Promise<void> {
  const client = createPublicClient({ transport: http(BASE_SEPOLIA.publicRpcUrl) })

  const chainId = await client.getChainId()
  const blockNumber = await client.getBlockNumber()

  if (chainId !== BASE_SEPOLIA.id) {
    throw new Error(`Expected chain ${String(BASE_SEPOLIA.id)}, got ${String(chainId)}.`)
  }

  process.stdout.write(`chain ${String(chainId)} @ block ${String(blockNumber)}\n\n`)

  // --- P-256 capability -----------------------------------------------------
  const raw = await client.call({ to: P256_PRECOMPILE_ADDRESS, data: P256_PROBE_CALLDATA })
  const strategy = await detectP256Strategy(client)

  const affirmative = raw.data?.toLowerCase() === P256_VALID_OUTPUT
  process.stdout.write(`P-256 at ${P256_PRECOMPILE_ADDRESS}\n`)
  process.stdout.write(`  returndata : ${raw.data ?? '(empty)'}\n`)
  process.stdout.write(`  affirmative: ${String(affirmative)}\n`)
  process.stdout.write(`  strategy   : ${strategy}\n\n`)

  if (!affirmative) {
    throw new Error('Precompile did not return an affirmative 1 for a known-valid signature.')
  }

  // --- Module deployments ---------------------------------------------------
  process.stdout.write('Module deployments\n')
  let missing = 0

  for (const name of MODULES) {
    const address = GLOBAL_CONSTANTS[name] as Address | undefined
    if (address === undefined) {
      process.stdout.write(`  ${name.padEnd(34)} NOT EXPORTED\n`)
      missing += 1
      continue
    }

    const code = await client.getCode({ address })
    const bytes = code !== undefined && code !== '0x' ? (code.length - 2) / 2 : 0

    process.stdout.write(
      `  ${name.padEnd(34)} ${address} ${bytes > 0 ? `${String(bytes)}b` : 'NO CODE'}\n`,
    )
    if (bytes === 0) missing += 1
  }

  if (missing > 0) {
    throw new Error(`${String(missing)} module address(es) are not deployed — do not hardcode them.`)
  }

  process.stdout.write('\nAll checks passed.\n')
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
