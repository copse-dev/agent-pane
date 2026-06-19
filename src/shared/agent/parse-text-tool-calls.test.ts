import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { recoverTextToolCalls, stripTextToolCallBlocks } from './parse-text-tool-calls.ts'

const SAMPLE = `I'll run eslint for you.

<tool_call>
<function=run_shell>
<parameter=command>
npx eslint . --format compact 2>&1 | head -50
</parameter>
<parameter=timeout_ms>
60000
</parameter>
</function>
</tool_call>`

describe('parse-text-tool-calls', () => {
  it('extracts run_shell from Cursor-style XML', () => {
    const { cleanedText, toolCalls } = recoverTextToolCalls(SAMPLE)
    assert.equal(toolCalls.length, 1)
    assert.equal(toolCalls[0]!.name, 'run_shell')
    assert.equal(
      (toolCalls[0]!.args as { command: string }).command,
      'npx eslint . --format compact 2>&1 | head -50',
    )
    assert.equal((toolCalls[0]!.args as { timeout_ms: number }).timeout_ms, 60000)
    assert.ok(cleanedText.includes("I'll run eslint"))
    assert.ok(!cleanedText.includes('<tool_call>'))
  })

  it('normalizes runshell alias', () => {
    const text = `<tool_call>
<function=runshell>
<parameter=command>echo hi</parameter>
</function>
</tool_call>`
    const { toolCalls } = recoverTextToolCalls(text)
    assert.equal(toolCalls[0]!.name, 'run_shell')
  })

  it('stripTextToolCallBlocks removes blocks without parsing', () => {
    const stripped = stripTextToolCallBlocks(SAMPLE)
    assert.ok(!stripped.includes('<function='))
    assert.ok(stripped.includes("I'll run eslint"))
  })
})
