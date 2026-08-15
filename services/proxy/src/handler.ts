import { z } from 'zod'
import { isMethodAllowed } from './methods.js'

/**
 * The stateless proxy (ARCHITECTURE.md §7).
 *
 * It exists for exactly one reason: bundler and paymaster API keys must not
 * ship inside the app binary, where they are extracted and abused within days.
 *
 * What it must never become:
 *
 *   - A signer. It holds no key material and rejects every signing method
 *     (Invariant 2). There is no code path here that can authorise anything.
 *   - A trust dependency. It is transport (Invariant 7). A hostile proxy can
 *     delay or censor; it cannot forge, because it never sees a private key and
 *     every response it relays is re-verified client-side by the bundler
 *     boundary in core/tx/bundler.ts.
 *   - A database. It persists nothing. There is no storage import in this
 *     service, and no module-level mutable state.
 *
 * The app must remain able to reach a public bundler directly when this is
 * unreachable. That fallback is what makes the non-custodial claim true rather
 * than aspirational, so it is a tested property of the app, not an assumption.
 */

export const UpstreamSchema = z.object({
  url: z.url(),
  /** Injected server-side. Never echoed to a client — see redactUpstreamDetail. */
  apiKey: z.string().min(1).optional(),
})

export const ProxyConfigSchema = z.object({
  /** At least two, so failover is possible (ARCHITECTURE.md §7). */
  upstreams: z.array(UpstreamSchema).min(1),
  maxBodyBytes: z.number().int().positive().default(128 * 1024),
})

export type Upstream = z.output<typeof UpstreamSchema>
export type ProxyConfig = z.output<typeof ProxyConfigSchema>

/** JSON-RPC 2.0 request, validated before anything touches an upstream. */
export const RpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]),
  method: z.string().min(1),
  params: z.array(z.unknown()).optional(),
})

export type RpcRequest = z.output<typeof RpcRequestSchema>

export interface ProxyResponse {
  readonly status: number
  readonly body: unknown
}

/** The subset of fetch this module needs, so tests need no network. */
export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

/** JSON-RPC error codes used here. */
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603

function rpcError(id: RpcRequest['id'], code: number, message: string): ProxyResponse {
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } }
}

/**
 * Strip anything that could carry a credential out of text bound for a client.
 *
 * THE LEAK THIS PREVENTS: provider API keys usually live in the URL path or a
 * query parameter. Upstream error messages and fetch exceptions routinely quote
 * the full request URL. Relaying an upstream error verbatim is therefore one of
 * the easiest ways to hand a client the key the proxy exists to hide — and it
 * happens on the error path, which is the path least likely to be exercised in
 * testing.
 *
 * So no upstream error text ever reaches a client. Clients get a generic
 * failure; operators get the detail from their own logs.
 */
function redactUpstreamDetail(): string {
  return 'Upstream provider unavailable.'
}

function withApiKey(upstream: Upstream): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (upstream.apiKey !== undefined) {
    headers['authorization'] = `Bearer ${upstream.apiKey}`
  }
  return { url: upstream.url, headers }
}

/**
 * Handle one JSON-RPC request.
 *
 * Pure with respect to the process: no globals, no caches, no storage. Every
 * call is independent, which is what "stateless" has to mean if it is to be
 * more than a claim in a document.
 */
export async function handleRpcRequest(args: {
  body: unknown
  config: ProxyConfig
  fetchUpstream: FetchLike
}): Promise<ProxyResponse> {
  const { body, config, fetchUpstream } = args

  const parsed = RpcRequestSchema.safeParse(body)
  if (!parsed.success) {
    return rpcError(null, INVALID_REQUEST, 'Malformed JSON-RPC request.')
  }
  const request = parsed.data

  if (!isMethodAllowed(request.method)) {
    /* Deliberately does not distinguish "unknown method" from "refused
       method". A client learns only that this proxy will not do it, which
       avoids turning the error into a map of what the proxy can be used for. */
    return rpcError(request.id, METHOD_NOT_FOUND, `Method "${request.method}" is not available.`)
  }

  const payload = JSON.stringify(request)
  if (Buffer.byteLength(payload, 'utf8') > config.maxBodyBytes) {
    return rpcError(request.id, INVALID_REQUEST, 'Request too large.')
  }

  /* Failover. A provider outage must not look like a wallet failure, so every
     configured upstream is tried before giving up. Order is configuration
     order; there is no health state kept between calls, because keeping one
     would make this service stateful for a marginal latency gain. */
  for (const upstream of config.upstreams) {
    const { url, headers } = withApiKey(upstream)

    try {
      const response = await fetchUpstream(url, { method: 'POST', headers, body: payload })
      if (!response.ok) continue

      const json: unknown = await response.json()
      return { status: 200, body: json }
    } catch {
      /* Intentionally swallowed *here* and only here: the next upstream is
         tried, and if every one fails the caller gets the generic error below.
         The exception may embed the credential-bearing URL, so it must not be
         rethrown toward a client. */
      continue
    }
  }

  return rpcError(request.id, INTERNAL_ERROR, redactUpstreamDetail())
}

export type BodyParseResult =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly response: ProxyResponse }

/**
 * Parse a raw request body, keeping JSON failures away from the handler.
 *
 * Returns a discriminated result rather than `ProxyResponse | unknown`, which
 * would collapse to `unknown` and quietly lose the distinction a caller needs.
 */
export function parseRequestBody(raw: string, maxBodyBytes: number): BodyParseResult {
  if (Buffer.byteLength(raw, 'utf8') > maxBodyBytes) {
    return { ok: false, response: rpcError(null, INVALID_REQUEST, 'Request too large.') }
  }
  try {
    return { ok: true, body: JSON.parse(raw) as unknown }
  } catch {
    return { ok: false, response: rpcError(null, PARSE_ERROR, 'Body is not valid JSON.') }
  }
}
