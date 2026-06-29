import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { at } from '@shared/array-utils.ts'
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
    assert.equal(at(toolCalls, 0).name, 'run_shell')
    assert.equal(
      (at(toolCalls, 0).args as { command: string } | undefined)?.command,
      'npx eslint . --format compact 2>&1 | head -50',
    )
    assert.equal((at(toolCalls, 0).args as { timeout_ms: number } | undefined)?.timeout_ms, 60000)
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
    assert.equal(at(toolCalls, 0).name, 'run_shell')
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
    assert.equal(at(toolCalls, 0).name, 'read_file')
    assert.equal(toolCalls[1]?.name, 'list_dir')
  })

  it('parses phantom export XML with multiline path parameters', () => {
    const text = `<tool_call>
<function=read_file>
<parameter=path>
src/renderer/views/titlebar.ts
</parameter>
</function>
</tool_call>
<tool_call>
<function=read_file>
<parameter=path>
src/renderer/views/projects-pane.ts
</parameter>
</function>
</tool_call>`
    const { toolCalls, keptRawBlocks } = recoverTextToolCalls(text)
    assert.equal(toolCalls.length, 2)
    assert.equal(keptRawBlocks, false)
    assert.equal(
      (at(toolCalls, 0).args as { path: string } | undefined)?.path,
      'src/renderer/views/titlebar.ts',
    )
    assert.equal(
      (toolCalls[1]?.args as { path: string } | undefined)?.path,
      'src/renderer/views/projects-pane.ts',
    )
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
      return parsed.success ? parsed.data : null
    })
    assert.equal(toolCalls.length, 1)
    assert.equal((at(toolCalls, 0).args as { start_line: number } | undefined)?.start_line, 10)
    assert.equal((at(toolCalls, 0).args as { end_line: number } | undefined)?.end_line, 20)
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

  it('stripTextToolCallBlocks holds an unterminated opener while streaming', () => {
    // Mid-stream: the closing </tool_call> has not arrived, so the raw XML must
    // not be shown — only the prose before the opener survives.
    const partial = `Let me render the demo for you.

<tool_call>
<function=render_html_artefact>
<parameter=html>
<!DOCTYPE html>`
    const stripped = stripTextToolCallBlocks(partial)
    assert.equal(stripped, 'Let me render the demo for you.')
    assert.ok(!stripped.includes('<tool_call>'))
    assert.ok(!stripped.includes('<function='))
    assert.ok(!stripped.includes('DOCTYPE'))
  })

  it('stripTextToolCallBlocks holds a partial opener tag mid-token', () => {
    assert.equal(stripTextToolCallBlocks('Working on it <tool_ca'), 'Working on it')
    assert.equal(stripTextToolCallBlocks('Working on it <'), 'Working on it')
    assert.equal(stripTextToolCallBlocks('Working on it < tool_call'), 'Working on it')
  })

  it('stripTextToolCallBlocks keeps a completed block then drops a new opener', () => {
    const stripped = stripTextToolCallBlocks(`${SAMPLE}\nNow another:\n<tool_call>\n<function=`)
    assert.ok(stripped.includes("I'll run eslint"))
    assert.ok(stripped.includes('Now another:'))
    assert.ok(!stripped.includes('<tool_call>'))
    assert.ok(!stripped.includes('<function='))
  })

  it('stripTextToolCallBlocks preserves unrelated angle brackets in prose', () => {
    assert.equal(stripTextToolCallBlocks('compare a < b and c > d'), 'compare a < b and c > d')
    assert.equal(stripTextToolCallBlocks('use a <div> wrapper'), 'use a <div> wrapper')
  })
})
