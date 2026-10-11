import { describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as httpsServer } from 'node:https'
import { createServer as httpServer } from 'node:http'
import type { Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { TLSSocket } from 'node:tls'
import { buildConnector } from 'undici'
import { createResolvedProviderFetch } from './resolved-provider-fetch.ts'
import { buildGuestProvider } from './guest-provider.ts'

// Public, test-only self-signed certificate for model.example; verification stays enabled.
const cert = readFileSync('tests/fixtures/cli-provider-transport/model.crt')
const key = readFileSync('tests/fixtures/cli-provider-transport/model.key')
async function listen(t: TestContext, server: Server, host = '127.0.0.1'): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return address.port
}
describe('CLI provider --resolve transport', () => {
  it('preserves URL authority, Host, TLS SNI and certificate verification through a mapped port', async (t) => {
    const server = httpsServer({ cert, key }, (request, response) => {
      assert.equal(request.url, '/v1/chat/completions')
      assert.equal(request.headers.host, 'model.example')
      assert.equal(request.headers.authorization, 'Bearer selected-key')
      assert.ok(request.socket instanceof TLSSocket)
      assert.equal(request.socket.servername, 'model.example')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        'data: ' +
          JSON.stringify({
            id: 'mapped',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'scripted',
            choices: [{ index: 0, delta: { content: 'mapped correctly' }, finish_reason: 'stop' }],
          }) +
          '\n\ndata: [DONE]\n\n',
      )
    })
    const port = await listen(t, server)
    const transport = createResolvedProviderFetch(
      { 'model.example': `127.0.0.1:${String(port)}` },
      buildConnector({ ca: cert }),
    )
    t.after(transport.close)
    const provider = buildGuestProvider(
      {
        kind: 'openai-compatible',
        model: 'scripted',
        apiKeySlug: 'cli',
        url: 'https://model.example/v1',
        label: 'CLI model',
        local: true,
        includeUsage: true,
        apiStyle: null,
        extraBody: null,
        params: { maxOutputTokens: 16384 },
      },
      'selected-key',
      transport.fetch,
    )
    let output = ''
    for await (const chunk of provider.stream([{ role: 'user', content: 'hello' }], []))
      if (chunk.type === 'text') output += chunk.text
    assert.equal(output, 'mapped correctly')
  })
  it('verifies the logical certificate name rather than trusting the dial destination', async (t) => {
    let requests = 0
    const server = httpsServer({ cert, key }, (_request, response) => {
      requests++
      response.end('bad')
    })
    const port = await listen(t, server)
    const transport = createResolvedProviderFetch(
      { 'wrong.example': `127.0.0.1:${String(port)}` },
      buildConnector({ ca: cert }),
    )
    t.after(transport.close)
    await assert.rejects(transport.fetch('https://wrong.example/v1'), (error: unknown) => {
      assert.ok(error instanceof Error && error.cause instanceof Error)
      assert.match(error.cause.message, /certificate|altname|hostname/i)
      return true
    })
    assert.equal(requests, 0)
  })
  it('maps an address without a port while retaining the logical nondefault port', async (t) => {
    let port = 0
    const server = httpsServer({ cert, key }, (request, response) => {
      assert.equal(request.headers.host, `model.example:${String(port)}`)
      response.end('same port')
    })
    port = await listen(t, server)
    const transport = createResolvedProviderFetch(
      { 'model.example': '127.0.0.1' },
      buildConnector({ ca: cert }),
    )
    t.after(transport.close)
    assert.equal(
      await (await transport.fetch(`https://model.example:${String(port)}/`)).text(),
      'same port',
    )
  })
  it('supports an IPv6 destination and keeps unmapped requests on their own origin', async (t) => {
    const server = httpsServer({ cert, key }, (request, response) => {
      assert.equal(request.headers.host, 'model.example')
      response.end('ipv6')
    })
    const port = await listen(t, server, '::1')
    const transport = createResolvedProviderFetch(
      { 'model.example': `[::1]:${String(port)}` },
      buildConnector({ ca: cert }),
    )
    t.after(transport.close)
    assert.equal(await (await transport.fetch('https://model.example/')).text(), 'ipv6')
    const plain = httpServer((_request, response) => response.end('unmapped'))
    const plainPort = await listen(t, plain)
    assert.equal(
      await (await transport.fetch(`http://127.0.0.1:${String(plainPort)}/`)).text(),
      'unmapped',
    )
  })
  it('preserves explicit default ports and bare IPv6 mappings at the connector boundary', async (t) => {
    const transport = createResolvedProviderFetch(
      { 'model.example': '127.0.0.1:80', 'ipv6.example': '::1' },
      (options, callback) => {
        if (options.servername === 'model.example') {
          assert.equal(options.hostname, '127.0.0.1')
          assert.equal(options.port, '80')
        } else {
          assert.equal(options.servername, 'ipv6.example')
          assert.equal(options.hostname, '::1')
          assert.equal(options.port, '8443')
        }
        callback(new Error('test connector completed'), null)
      },
    )
    t.after(transport.close)
    await assert.rejects(transport.fetch('https://model.example/'))
    await assert.rejects(transport.fetch('https://ipv6.example:8443/'))
  })
  it('refuses an unmapped reserved alias before DNS and maps localhost only to loopback', async (t) => {
    const missing = createResolvedProviderFetch({})
    t.after(missing.close)
    await assert.rejects(missing.fetch('http://model.copse.internal/'), (error: unknown) => {
      assert.ok(error instanceof Error && error.cause instanceof Error)
      assert.match(error.cause.message, /loopback/)
      return true
    })
    const server = httpServer((request, response) => {
      assert.equal(request.headers.host, 'model.copse.internal')
      response.end('local alias')
    })
    const port = await listen(t, server)
    const transport = createResolvedProviderFetch({
      'model.copse.internal': `localhost:${String(port)}`,
    })
    t.after(transport.close)
    assert.equal(
      await (await transport.fetch('http://model.copse.internal/')).text(),
      'local alias',
    )
  })
  it('retains the reserved alias loopback constraint and does not resolve inherited entries', async (t) => {
    assert.throws(
      () => createResolvedProviderFetch({ 'model.copse.internal': 'external.example' }),
      /loopback/,
    )
    const mappings: Record<string, string> = {}
    const transport = createResolvedProviderFetch(mappings, (options, callback) => {
      assert.equal(options.hostname, 'constructor')
      callback(new Error('unmapped origin'), null)
    })
    t.after(transport.close)
    await assert.rejects(transport.fetch('https://constructor/'))
  })
})
