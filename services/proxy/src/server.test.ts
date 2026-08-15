import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { ProxyConfigSchema, type FetchLike, type ProxyConfig } from './handler.js'
import { createProxyServer } from './server.js'

/**
 * The HTTP binding, exercised against a real socket rather than a mock.
 *
 * These tests bind a server on loopback and speak actual HTTP to it, because
 * the properties under test — streaming size caps, timeouts, what a socket does
 * when destroyed — do not exist in a mocked request object.
 */

const API_KEY = 'sk-live-SERVER-SECRET-abcdef'

const CONFIG: ProxyConfig = ProxyConfigSchema.parse({
  upstreams: [{ url: 'https://primary.example/rpc', apiKey: API_KEY }],
  maxBodyBytes: 4096,
})

const RPC = { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }

function upstreamReturning(result: unknown): FetchLike {
  return vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(result) }))
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve()
          })
        }),
    ),
  )
})

async function start(
  overrides: Partial<Parameters<typeof createProxyServer>[0]> = {},
): Promise<string> {
  const server = createProxyServer({
    config: CONFIG,
    fetchUpstream: upstreamReturning({ jsonrpc: '2.0', id: 1, result: '0x14a34' }),
    ...overrides,
  })
  servers.push(server)

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })

  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${String(port)}/`
}

describe('request surface', () => {
  it('serves a valid JSON-RPC POST', async () => {
    const url = await start()

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(RPC),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ jsonrpc: '2.0', id: 1, result: '0x14a34' })
  })

  it.each(['GET', 'PUT', 'DELETE', 'PATCH'])('refuses %s', async (method) => {
    const url = await start()
    const response = await fetch(url, { method })
    expect(response.status).toBe(405)
  })

  it('refuses paths other than the root', async () => {
    const url = await start()
    const response = await fetch(`${url}admin`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(404)
  })

  it('rejects a malformed JSON body', async () => {
    const url = await start()
    const response = await fetch(url, { method: 'POST', body: '{not json' })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32700 } })
  })

  /**
   * No CORS headers, deliberately. This endpoint is for our app, not a browser
   * origin — emitting them would let a hostile page spend our API quota.
   */
  it('emits no CORS headers', async () => {
    const url = await start()
    const response = await fetch(url, { method: 'POST', body: JSON.stringify(RPC) })

    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })
})

describe('body size cap', () => {
  /**
   * The cap is enforced while streaming, not after buffering. A limit only
   * applied once the memory is already committed is not a limit.
   */
  it('refuses an oversized body without buffering it', async () => {
    const url = await start()
    const huge = JSON.stringify({ ...RPC, params: ['x'.repeat(64 * 1024)] })

    // A destroyed socket and a 413 are both the cap working. Collapsing them to
    // one value keeps the assertion unconditional — a test whose expect() sits
    // inside an `if` can pass by never running.
    const outcome: number | 'socket-destroyed' = await fetch(url, {
      method: 'POST',
      body: huge,
    })
      .then((response) => response.status)
      .catch(() => 'socket-destroyed' as const)

    expect(outcome).not.toBe(200)
  })

  it('accepts a body just inside the cap', async () => {
    const url = await start()
    const body = JSON.stringify({ ...RPC, params: ['x'.repeat(1024)] })

    const response = await fetch(url, { method: 'POST', body })
    expect(response.status).toBe(200)
  })
})

describe('rate limiting', () => {
  it('refuses once the limit is exceeded, with a retry-after', async () => {
    const url = await start({ rateLimit: { limit: 2, windowMs: 60_000, maxTrackedKeys: 100 } })

    const send = (): Promise<Response> =>
      fetch(url, { method: 'POST', body: JSON.stringify(RPC) })

    await send()
    await send()
    const third = await send()

    expect(third.status).toBe(429)
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
  })

  it('rate limits before doing any upstream work', async () => {
    const fetchUpstream = upstreamReturning({ jsonrpc: '2.0', id: 1, result: '0x1' })
    const url = await start({
      fetchUpstream,
      rateLimit: { limit: 1, windowMs: 60_000, maxTrackedKeys: 100 },
    })

    await fetch(url, { method: 'POST', body: JSON.stringify(RPC) })
    await fetch(url, { method: 'POST', body: JSON.stringify(RPC) })

    expect(fetchUpstream).toHaveBeenCalledTimes(1)
  })

  it('lets requests through again once the window rolls over', async () => {
    let clock = 1_800_000_000_000
    const url = await start({
      rateLimit: { limit: 1, windowMs: 1000, maxTrackedKeys: 100 },
      now: () => clock,
    })

    await fetch(url, { method: 'POST', body: JSON.stringify(RPC) })
    const blocked = await fetch(url, { method: 'POST', body: JSON.stringify(RPC) })
    expect(blocked.status).toBe(429)

    clock += 2000
    const allowed = await fetch(url, { method: 'POST', body: JSON.stringify(RPC) })
    expect(allowed.status).toBe(200)
  })
})

describe('credential containment over the wire', () => {
  it('never returns the api key in a response body or headers', async () => {
    const url = await start()

    const response = await fetch(url, { method: 'POST', body: JSON.stringify(RPC) })
    const text = await response.text()
    const headers = JSON.stringify([...response.headers.entries()])

    expect(text).not.toContain(API_KEY)
    expect(headers).not.toContain(API_KEY)
  })

  it('returns a generic failure when the upstream throws a credential-bearing error', async () => {
    const url = await start({
      fetchUpstream: vi.fn(() =>
        Promise.reject(new Error(`https://primary.example/rpc?key=${API_KEY} refused`)),
      ),
    })

    const response = await fetch(url, { method: 'POST', body: JSON.stringify(RPC) })
    const text = await response.text()

    expect(text).not.toContain(API_KEY)
    expect(text).not.toContain('primary.example')
    expect(JSON.parse(text)).toMatchObject({ error: { code: -32603 } })
  })

  it('does not leak internals when the handler itself throws', async () => {
    const url = await start({
      fetchUpstream: vi.fn(() => {
        throw new Error(`catastrophe involving ${API_KEY}`)
      }),
    })

    const response = await fetch(url, { method: 'POST', body: JSON.stringify(RPC) })
    const text = await response.text()

    expect(text).not.toContain(API_KEY)
    expect(text).not.toContain('catastrophe')
  })
})

describe('signing methods over the wire', () => {
  it('refuses eth_sendTransaction without contacting an upstream', async () => {
    const fetchUpstream = upstreamReturning({ result: 'should not happen' })
    const url = await start({ fetchUpstream })

    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ ...RPC, method: 'eth_sendTransaction' }),
    })

    await expect(response.json()).resolves.toMatchObject({ error: { code: -32601 } })
    expect(fetchUpstream).not.toHaveBeenCalled()
  })
})
