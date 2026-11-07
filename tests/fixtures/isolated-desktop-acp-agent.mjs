// Protocol fixture for isolated-desktop-approval.e2e.ts. No model or credentials.
// It uses only the authenticated MCP endpoint supplied by Copse in session/new.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable'

let bridge
let requestId = 0

async function rpc(method, params, authenticated = true) {
  assert.ok(bridge, 'Copse must offer its native HTTP bridge')
  const response = await globalThis.fetch(bridge.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...Object.fromEntries(
        authenticated ? bridge.headers.map(({ name, value }) => [name, value]) : [],
      ),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
    signal: globalThis.AbortSignal.timeout(90_000),
  })
  if (!authenticated) {
    assert.equal(response.status, 401, 'The bridge must reject unauthenticated callers')
    await response.text()
    return
  }
  assert.equal(response.status, 200)
  const text = await response.text()
  const data = text.split('\n').filter((line) => line.startsWith('data:'))
  const message = JSON.parse(data.length ? data.at(-1).slice(5) : text)
  assert.equal(message.error, undefined, JSON.stringify(message.error))
  return message.result
}

async function call(args, expected) {
  const result = await rpc('tools/call', { name: 'isolated_copse', arguments: args })
  assert.ok(!result.isError, JSON.stringify(result))
  assert.ok(
    result.content.some((part) => part.type === 'text' && part.text.includes(expected)),
    JSON.stringify(result),
  )
  return result
}

agent({ name: 'isolated-desktop-acceptance' })
  .onRequest('initialize', () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { mcpCapabilities: { http: true } },
  }))
  .onRequest('session/new', async (ctx) => {
    bridge = ctx.params.mcpServers.find(
      (server) => server.name === 'copse' && server.type === 'http',
    )
    assert.ok(bridge, 'The registered ACP agent must receive the native bridge')
    await rpc('tools/list', {}, false)
    await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'isolated-desktop-acceptance', version: '1' },
    })
    const listed = await rpc('tools/list', {})
    assert.ok(listed.tools.some((tool) => tool.name === 'isolated_copse'))
    return { sessionId: 'isolated-desktop-acceptance' }
  })
  .onRequest('session/prompt', async (ctx) => {
    assert.ok(
      ctx.params.prompt.some(
        (block) =>
          block.type === 'text' &&
          block.text.includes('Verify isolated desktop control through ACP.'),
      ),
    )
    await call({ action: 'start', model: 'isolated-approval:demo' }, 'Started isolated desktop')
    // Each RPC fully consumes/closes its response. The VM must survive that
    // HTTP lifetime boundary so a later request in the owning turn can use it.
    try {
      const shot = await call({ action: 'screenshot' }, 'screenshot is attached')
      const png = shot.content.find(
        (part) => part.type === 'image' && part.mimeType === 'image/png',
      )
      assert.ok(png, 'The real VM must return a PNG over the authenticated bridge')
      const bytes = Buffer.from(png.data, 'base64')
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      assert.equal(bytes.readUInt32BE(16), 1280)
      assert.equal(bytes.readUInt32BE(20), 800)
      assert.ok(process.argv[2], 'The spec must supply its guest screenshot artifact path')
      writeFileSync(process.argv[2], bytes)
    } finally {
      await call({ action: 'stop' }, 'VM deleted')
    }
    // A successful Stop response must also release the session's authority.
    const revoked = await rpc('tools/call', {
      name: 'isolated_copse',
      arguments: { action: 'screenshot' },
    })
    assert.equal(revoked.isError, true)
    assert.ok(
      revoked.content.some(
        (part) => part.type === 'text' && part.text.includes('no isolated desktop'),
      ),
    )
    await ctx.client.notify(methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Authenticated ACP desktop captured, deleted and revoked.' },
      },
    })
    return { stopReason: 'end_turn' }
  })
  .onNotification('session/cancel', () => {})
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
