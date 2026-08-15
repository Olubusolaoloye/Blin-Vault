import { describe, expect, it, vi } from 'vitest'
import { NEVER_FORWARDED } from './methods.js'
import {
  handleRpcRequest,
  parseRequestBody,
  ProxyConfigSchema,
  type FetchLike,
  type ProxyConfig,
} from './handler.js'

const API_KEY = 'sk-live-SUPER-SECRET-abcdef123456'

const CONFIG: ProxyConfig = ProxyConfigSchema.parse({
  upstreams: [
    { url: 'https://primary.example/rpc', apiKey: API_KEY },
    { url: 'https://secondary.example/rpc', apiKey: 'sk-live-BACKUP-KEY-987654' },
  ],
})

const REQUEST = { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }

function upstreamReturning(result: unknown): FetchLike {
  return vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(result) }),
  )
}

function upstreamFailing(error: Error): FetchLike {
  return vi.fn(() => Promise.reject(error))
}

describe('method allowlist', () => {
  it('forwards an allowed read method', async () => {
    const response = await handleRpcRequest({
      body: REQUEST,
      config: CONFIG,
      fetchUpstream: upstreamReturning({ jsonrpc: '2.0', id: 1, result: '0x14a34' }),
    })

    expect(response.body).toEqual({ jsonrpc: '2.0', id: 1, result: '0x14a34' })
  })

  it('forwards bundler methods', async () => {
    for (const method of ['eth_sendUserOperation', 'eth_estimateUserOperationGas']) {
      const fetchUpstream = upstreamReturning({ jsonrpc: '2.0', id: 1, result: '0x' })
      await handleRpcRequest({
        body: { ...REQUEST, method },
        config: CONFIG,
        fetchUpstream,
      })
      expect(fetchUpstream).toHaveBeenCalled()
    }
  })

  /**
   * Invariant 2: the provider holds no signer. Upstream would reject these
   * anyway — the proxy has no accounts — but forwarding them would make the
   * proxy look like a signing service, and the shape of an interface teaches
   * people what it is for.
   */
  it.each([...NEVER_FORWARDED])('refuses %s and does not contact any upstream', async (method) => {
    const fetchUpstream = upstreamReturning({ result: 'should not happen' })

    const response = await handleRpcRequest({
      body: { ...REQUEST, method },
      config: CONFIG,
      fetchUpstream,
    })

    expect(response.body).toMatchObject({ error: { code: -32601 } })
    expect(fetchUpstream).not.toHaveBeenCalled()
  })

  it('refuses an unknown method', async () => {
    const fetchUpstream = upstreamReturning({})
    const response = await handleRpcRequest({
      body: { ...REQUEST, method: 'debug_traceTransaction' },
      config: CONFIG,
      fetchUpstream,
    })

    expect(response.body).toMatchObject({ error: { code: -32601 } })
    expect(fetchUpstream).not.toHaveBeenCalled()
  })
})

/**
 * The reason this service exists. If a key can reach a client, shipping it in
 * the app binary would have been no worse.
 */
describe('credential containment', () => {
  it('never puts the api key in a successful response', async () => {
    const response = await handleRpcRequest({
      body: REQUEST,
      config: CONFIG,
      fetchUpstream: upstreamReturning({ jsonrpc: '2.0', id: 1, result: '0x14a34' }),
    })

    expect(JSON.stringify(response)).not.toContain(API_KEY)
  })

  /**
   * The error path is where this leaks in practice: provider keys live in URLs,
   * upstream errors quote the request URL, and error paths are the least
   * exercised in testing. No upstream error text reaches a client.
   */
  it('never leaks the api key through an upstream exception', async () => {
    const leaky = new Error(
      `request to https://primary.example/rpc?apiKey=${API_KEY} failed: ECONNRESET`,
    )

    const response = await handleRpcRequest({
      body: REQUEST,
      config: CONFIG,
      fetchUpstream: upstreamFailing(leaky),
    })

    const serialised = JSON.stringify(response)
    expect(serialised).not.toContain(API_KEY)
    expect(serialised).not.toContain('ECONNRESET')
    expect(serialised).not.toContain('primary.example')
  })

  it('never leaks any configured key, including the backup', async () => {
    const response = await handleRpcRequest({
      body: REQUEST,
      config: CONFIG,
      fetchUpstream: upstreamFailing(new Error('boom')),
    })

    const serialised = JSON.stringify(response)
    for (const upstream of CONFIG.upstreams) {
      if (upstream.apiKey !== undefined) expect(serialised).not.toContain(upstream.apiKey)
    }
  })

  it('sends the key to the upstream and not in the forwarded body', async () => {
    const fetchUpstream = upstreamReturning({ jsonrpc: '2.0', id: 1, result: '0x1' })

    await handleRpcRequest({ body: REQUEST, config: CONFIG, fetchUpstream })

    const call = vi.mocked(fetchUpstream).mock.calls[0]
    expect(call?.[1].headers['authorization']).toBe(`Bearer ${API_KEY}`)
    expect(call?.[1].body).not.toContain(API_KEY)
  })
})

describe('failover', () => {
  it('tries the next upstream when the first throws', async () => {
    const fetchUpstream: FetchLike = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: '0xbackup' }),
      })

    const response = await handleRpcRequest({ body: REQUEST, config: CONFIG, fetchUpstream })

    expect(response.body).toMatchObject({ result: '0xbackup' })
    expect(fetchUpstream).toHaveBeenCalledTimes(2)
  })

  it('tries the next upstream on a non-ok status', async () => {
    const fetchUpstream: FetchLike = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: '0xok' }),
      })

    const response = await handleRpcRequest({ body: REQUEST, config: CONFIG, fetchUpstream })
    expect(response.body).toMatchObject({ result: '0xok' })
  })

  it('reports a generic failure when every upstream is down', async () => {
    const response = await handleRpcRequest({
      body: REQUEST,
      config: CONFIG,
      fetchUpstream: upstreamFailing(new Error('down')),
    })

    expect(response.body).toMatchObject({ error: { code: -32603 } })
  })

  it('preserves the request id so a client can correlate a failure', async () => {
    const response = await handleRpcRequest({
      body: { ...REQUEST, id: 'abc' },
      config: CONFIG,
      fetchUpstream: upstreamFailing(new Error('down')),
    })

    expect(response.body).toMatchObject({ id: 'abc' })
  })
})

describe('statelessness', () => {
  /**
   * "Stateless" has to mean something testable. A failing upstream must not be
   * remembered: no health cache, no circuit breaker, no accumulated state that
   * would make one request's outcome depend on another's.
   */
  it('does not remember a previously failing upstream', async () => {
    const failing = upstreamFailing(new Error('down'))
    await handleRpcRequest({ body: REQUEST, config: CONFIG, fetchUpstream: failing })

    const healthy = upstreamReturning({ jsonrpc: '2.0', id: 1, result: '0x14a34' })
    const response = await handleRpcRequest({ body: REQUEST, config: CONFIG, fetchUpstream: healthy })

    expect(response.body).toMatchObject({ result: '0x14a34' })
    // The first upstream is tried again, not skipped from a remembered failure.
    expect(healthy).toHaveBeenCalledTimes(1)
  })

  it('produces identical output for identical input', async () => {
    const first = await handleRpcRequest({
      body: REQUEST,
      config: CONFIG,
      fetchUpstream: upstreamReturning({ jsonrpc: '2.0', id: 1, result: '0x1' }),
    })
    const second = await handleRpcRequest({
      body: REQUEST,
      config: CONFIG,
      fetchUpstream: upstreamReturning({ jsonrpc: '2.0', id: 1, result: '0x1' }),
    })

    expect(first).toEqual(second)
  })
})

describe('request validation', () => {
  it.each([
    ['null', null],
    ['a string', 'hello'],
    ['an array', []],
    ['a missing method', { jsonrpc: '2.0', id: 1 }],
    ['a wrong jsonrpc version', { jsonrpc: '1.0', id: 1, method: 'eth_chainId' }],
    ['an empty method', { jsonrpc: '2.0', id: 1, method: '' }],
    ['params that are not an array', { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: {} }],
  ])('rejects %s without contacting an upstream', async (_label, body) => {
    const fetchUpstream = upstreamReturning({})
    const response = await handleRpcRequest({ body, config: CONFIG, fetchUpstream })

    expect(response.body).toMatchObject({ error: { code: -32600 } })
    expect(fetchUpstream).not.toHaveBeenCalled()
  })

  it('rejects an oversized request', async () => {
    const huge = { ...REQUEST, params: ['x'.repeat(200 * 1024)] }
    const fetchUpstream = upstreamReturning({})

    const response = await handleRpcRequest({ body: huge, config: CONFIG, fetchUpstream })

    expect(response.body).toMatchObject({ error: { code: -32600 } })
    expect(fetchUpstream).not.toHaveBeenCalled()
  })
})

describe('parseRequestBody', () => {
  it('parses valid JSON', () => {
    expect(parseRequestBody('{"a":1}', 1024)).toEqual({ ok: true, body: { a: 1 } })
  })

  it('reports invalid JSON as a parse error rather than throwing', () => {
    const result = parseRequestBody('{not json', 1024)
    expect(result).toMatchObject({ ok: false, response: { body: { error: { code: -32700 } } } })
  })

  it('rejects a body over the size limit before parsing it', () => {
    const result = parseRequestBody('x'.repeat(2048), 1024)
    expect(result).toMatchObject({ ok: false, response: { body: { error: { code: -32600 } } } })
  })
})

describe('ProxyConfigSchema', () => {
  it('requires at least one upstream', () => {
    expect(ProxyConfigSchema.safeParse({ upstreams: [] }).success).toBe(false)
  })

  it('rejects a non-URL upstream', () => {
    expect(ProxyConfigSchema.safeParse({ upstreams: [{ url: 'not-a-url' }] }).success).toBe(false)
  })

  it('allows an upstream with no key, for a public endpoint', () => {
    expect(
      ProxyConfigSchema.safeParse({ upstreams: [{ url: 'https://sepolia.base.org' }] }).success,
    ).toBe(true)
  })
})
