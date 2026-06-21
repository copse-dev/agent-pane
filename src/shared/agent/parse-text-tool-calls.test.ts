import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  recoverTextToolCalls,
  stripTextToolCallBlocks,
  coerceStringlyTypedToolArgs,
} from './parse-text-tool-calls.ts'

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

  it('extracts multiple functions in one tool_call block', () => {
    const text = `<tool_call>
<function=read_file>
<parameter=path>src/a.ts</parameter>
</function>
<function=list_dir>
<parameter=path>.</parameter>
</function>
</tool_call>`
    const { toolCalls } = recoverTextToolCalls(text)
    assert.equal(toolCalls.length, 2)
    assert.equal(toolCalls[0]!.name, 'read_file')
    assert.equal(toolCalls[1]!.name, 'list_dir')
  })

  it('coerces line numbers via schema callback', () => {
    const readFileSchema = z.object({
      path: z.string(),
      start_line: z.number().int().min(1).optional(),
      end_line: z.number().int().min(1).optional(),
    })
    const text = `<tool_call>
<function=read_file>
<parameter=path>foo.ts</parameter>
<parameter=start_line>10</parameter>
<parameter=end_line>20</parameter>
</function>
</tool_call>`
    const { toolCalls } = recoverTextToolCalls(text, (name, args) => {
      if (name !== 'read_file') return null
      const parsed = readFileSchema.safeParse(args)
      return parsed.success ? (parsed.data as Record<string, unknown>) : null
    })
    assert.equal(toolCalls.length, 1)
    assert.equal((toolCalls[0]!.args as { start_line: number }).start_line, 10)
    assert.equal((toolCalls[0]!.args as { end_line: number }).end_line, 20)
  })

  it('keeps raw XML when blocks fail to parse', () => {
    const text = `Here is the call:
<tool_call>
<function=read_file>
<parameter=path></parameter>
</function>
</tool_call>`
    const { cleanedText, toolCalls, keptRawBlocks } = recoverTextToolCalls(text, () => null)
    assert.equal(toolCalls.length, 0)
    assert.equal(keptRawBlocks, true)
    assert.ok(cleanedText.includes('<tool_call>'))
  })

  it('coerceStringlyTypedToolArgs converts numeric strings', () => {
    assert.deepEqual(coerceStringlyTypedToolArgs({ timeout_ms: '60000' }), { timeout_ms: 60000 })
  })

  it('stripTextToolCallBlocks removes blocks without parsing', () => {
    const stripped = stripTextToolCallBlocks(SAMPLE)
    assert.ok(!stripped.includes('<function='))
    assert.ok(stripped.includes("I'll run eslint"))
  })
})
