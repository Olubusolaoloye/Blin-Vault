import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { handleRpcRequest, parseRequestBody, type FetchLike, type ProxyConfig } from './handler.js'
import { DEFAULT_RATE_LIMIT, RateLimiter, type RateLimitConfig } from './rateLimit.js'

/**
 * HTTP binding for the proxy.
 *
 * The handler decides *what* to forward; this decides what is even allowed to
 * reach it. Everything here is about the requests that never get that far.
 */

export interface ServerOptions {
  readonly config: ProxyConfig
  readonly fetchUpstream: FetchLike
  readonly rateLimit?: RateLimitConfig
  /** Injected so tests do not depend on wall-clock time. */
  readonly now?: () => number
  /** How long a client may take to send its body before the socket is dropped. */
  readonly requestTimeoutMs?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload, 'utf8'),
    /* This endpoint is for our app, not a browser origin. No CORS headers are
       emitted, so a hostile page cannot make a browser spend our API quota with
       the user's cookies attached. */
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(payload)
}

/**
 * Read a request body with the size cap enforced DURING streaming.
 *
 * WHY NOT BUFFER THEN CHECK: checking the length after collecting the body
 * means an attacker gets to allocate the whole thing first. A cap that is only
 * enforced once the memory is already committed is not a cap. The connection is
 * destroyed the moment the limit is crossed, so an oversized upload costs the
 * proxy one buffer of `maxBodyBytes`, not one of whatever was sent.
 *
 * Content-Length is deliberately not trusted for this — it is client-supplied
 * and a chunked request need not send one at all.
 */
async function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    request.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBodyBytes) {
        request.destroy()
        finish(null)
        return
      }
      chunks.push(chunk)
    })

    request.on('end', () => {
      finish(Buffer.concat(chunks).toString('utf8'))
    })

    request.on('error', () => {
      finish(null)
    })
  })
}

/**
 * Identify the caller for rate limiting.
 *
 * Uses the socket address only. X-Forwarded-For is deliberately ignored: it is
 * client-controlled, so honouring it lets an attacker mint a fresh identity per
 * request and walk straight through the limiter. A deployment behind a trusted
 * proxy must set this from infrastructure it controls, not from a header.
 */
function callerKey(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? 'unknown'
}

export function createProxyServer(options: ServerOptions): Server {
  const {
    config,
    fetchUpstream,
    rateLimit = DEFAULT_RATE_LIMIT,
    now = () => Date.now(),
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = options

  const limiter = new RateLimiter(rateLimit)

  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: { code: -32600, message: 'Method not allowed.' } })
          return
        }

        if ((request.url ?? '/') !== '/') {
          sendJson(response, 404, { error: { code: -32600, message: 'Not found.' } })
          return
        }

        const verdict = limiter.check(callerKey(request), now())
        if (!verdict.allowed) {
          response.setHeader('retry-after', String(verdict.retryAfterSeconds))
          sendJson(response, 429, { error: { code: -32005, message: 'Too many requests.' } })
          return
        }

        const raw = await readBody(request, config.maxBodyBytes)
        if (raw === null) {
          sendJson(response, 413, { error: { code: -32600, message: 'Request too large.' } })
          return
        }

        const parsed = parseRequestBody(raw, config.maxBodyBytes)
        if (!parsed.ok) {
          sendJson(response, parsed.response.status, parsed.response.body)
          return
        }

        const result = await handleRpcRequest({ body: parsed.body, config, fetchUpstream })
        sendJson(response, result.status, result.body)
      } catch {
        /* Swallowed deliberately and only here. An exception at this layer may
           embed a credential-bearing upstream URL, so nothing about it is
           relayed — the client gets a generic failure and the operator reads
           their own logs (same reasoning as redactUpstreamDetail). */
        if (!response.headersSent) {
          sendJson(response, 500, { error: { code: -32603, message: 'Internal error.' } })
        }
      }
    })()
  })

  server.requestTimeout = requestTimeoutMs
  server.headersTimeout = requestTimeoutMs

  return server
}
