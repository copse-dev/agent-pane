import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { COMMAND_OUTPUT_TRUNCATED_MARKER } from '../exec/subprocess-output-cap.ts'
import { MCP_TOOL_OUTPUT_MAX_BYTES, mcpToolResultText } from './mcp-registry.ts'

function buildLog(lines: number): string {
  let out = ''
  for (let i = 0; i < lines; i++) out += `Compiling module ${String(i)} of the workspace target\n`
  return out
}

describe('mcpToolResultText', () => {
  it('returns small results unchanged', () => {
    const content = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]
    assert.equal(mcpToolResultText(content, {}), 'first\nsecond')
  })

  it('caps an oversized result and keeps failures from the dropped middle', () => {
    const middleError = "/repo/App/View.swift:12:5: error: cannot find 'foo' in scope"
    const content = [
      { type: 'text', text: buildLog(3000) },
      { type: 'text', text: `${middleError}\n${buildLog(3000)}` },
    ]
    const text = mcpToolResultText(content, {})
    assert.ok(Buffer.byteLength(text, 'utf8') <= MCP_TOOL_OUTPUT_MAX_BYTES)
    assert.ok(text.includes(COMMAND_OUTPUT_TRUNCATED_MARKER))
    assert.ok(text.includes(`\n${middleError}\n`))
    assert.ok(text.startsWith('Compiling module 0 '))
    assert.ok(text.endsWith('Compiling module 2999 of the workspace target\n'))
  })

  it('caps oversized resource text too', () => {
    const content = [
      { type: 'resource', resource: { uri: 'file:///big.log', text: buildLog(6000) } },
    ]
    const text = mcpToolResultText(content, {})
    assert.ok(Buffer.byteLength(text, 'utf8') <= MCP_TOOL_OUTPUT_MAX_BYTES)
    assert.match(text, /\[dropped \d+ bytes/)
  })
})
