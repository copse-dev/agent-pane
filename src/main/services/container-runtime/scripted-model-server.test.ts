import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startScriptedModelServer, type ScriptedModelServer } from './scripted-model-server.ts'

const tools = [{ type: 'function', function: { name: 'write_file' } }]

async function complete(server: ScriptedModelServer, body: unknown): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${String(server.port)}/v1/chat/completions`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 200)
  return response.text()
}

test('tool-free helpers never consume the agent script, regardless of request order', async () => {
  const server = await startScriptedModelServer(
    [
      { kind: 'tool', name: 'write_file', args: { path: 'fixture.txt', content: 'written' } },
      { kind: 'text', text: 'Main run finished.' },
    ],
    { textOnlyResponse: 'Stable helper title' },
  )
  try {
    assert.match(await complete(server, {}), /Stable helper title/)
    assert.equal(server.scriptedRequests, 0)
    assert.match(await complete(server, { tools }), /write_file/)
    assert.match(await complete(server, { tools: [] }), /Stable helper title/)
    assert.equal(server.scriptedRequests, 1)
    assert.match(await complete(server, { tools }), /Main run finished/)
    assert.match(await complete(server, {}), /Stable helper title/)
    assert.equal(server.scriptedRequests, 2)
    assert.equal(server.completionRequests, 5)
  } finally {
    await server.stop()
  }
})

test('malformed routed requests do not advance the agent script', async () => {
  const server = await startScriptedModelServer([{ kind: 'text', text: 'Still first.' }], {
    textOnlyResponse: 'Helper',
  })
  try {
    for (const body of ['{broken', JSON.stringify({ tools: 'invalid' }), 'null']) {
      const response = await fetch(`http://127.0.0.1:${String(server.port)}/v1/chat/completions`, {
        method: 'POST',
        body,
      })
      assert.equal(response.status, 400)
      await response.text()
    }
    assert.equal(server.scriptedRequests, 0)
    assert.match(await complete(server, { tools }), /Still first/)
  } finally {
    await server.stop()
  }
})

test('existing unpartitioned scripts still serve tool-free requests in order', async () => {
  const server = await startScriptedModelServer([
    { kind: 'text', text: 'First.' },
    { kind: 'text', text: 'Second.' },
  ])
  try {
    assert.match(await complete(server, {}), /First/)
    assert.match(await complete(server, {}), /Second/)
    assert.match(await complete(server, {}), /Done/)
    assert.equal(server.scriptedRequests, 2)
    assert.equal(server.completionRequests, 3)
  } finally {
    await server.stop()
  }
})
