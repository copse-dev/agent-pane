import assert from 'node:assert/strict'
import test from 'node:test'
import { hardenMessage } from './acp-transport.mjs'
test('ACP session disables native and MCP tools, setting sources, permission bypass and continuation', () => {
  const message = hardenMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: { cwd: '/workspace/empty', mcpServers: [{ name: 'unwanted' }] },
  })
  assert.deepEqual(message.params.mcpServers, [])
  assert.deepEqual(message.params._meta.claudeCode.options.tools, [])
  assert.deepEqual(message.params._meta.claudeCode.options.settingSources, [])
  assert.equal(message.params._meta.claudeCode.options.strictMcpConfig, true)
  assert.equal(message.params._meta.claudeCode.options.allowDangerouslySkipPermissions, false)
  assert.equal(message.params._meta.claudeCode.options.maxTurns, 1)
  const prompt = {
    method: 'session/prompt',
    params: { prompt: [{ type: 'text', text: 'fixture' }] },
  }
  assert.deepEqual(hardenMessage(prompt), prompt)
})
