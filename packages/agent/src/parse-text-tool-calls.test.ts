import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { at } from './internal-utils.ts'
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

  it('parses MiniMax `<invoke>` tool calls wrapped in `]<]minimax[>[` delimiters (#519)', () => {
    const text = `Let me check the branch.

]<]minimax[>[<tool_call>
]<]minimax[>[<invoke name="run_shell">]<]minimax[>[<command>git fetch origin main 2>&1 | tail -5]<]minimax[>[</command>]<]minimax[>[<timeout_ms>30000]<]minimax[>[</timeout_ms>]<]minimax[>[</invoke>
]<]minimax[>[</tool_call>`
    const { cleanedText, toolCalls, keptRawBlocks } = recoverTextToolCalls(text)
    assert.equal(keptRawBlocks, false)
    assert.equal(toolCalls.length, 1)
    assert.equal(at(toolCalls, 0).name, 'run_shell')
    assert.equal(
      (at(toolCalls, 0).args as { command: string } | undefined)?.command,
      'git fetch origin main 2>&1 | tail -5',
    )
    assert.equal((at(toolCalls, 0).args as { timeout_ms: number } | undefined)?.timeout_ms, 30000)
    assert.ok(cleanedText.includes('Let me check the branch'))
    assert.ok(!cleanedText.includes('minimax'))
    assert.ok(!cleanedText.includes('<invoke'))
  })

  it('parses an `<invoke>` block with no `<tool_call>` wrapper', () => {
    const text = `<invoke name="read_file"><path>src/a.ts</path></invoke>`
    const { toolCalls } = recoverTextToolCalls(text)
    assert.equal(toolCalls.length, 1)
    assert.equal(at(toolCalls, 0).name, 'read_file')
    assert.equal((at(toolCalls, 0).args as { path: string } | undefined)?.path, 'src/a.ts')
  })

  it('parses Anthropic-style `<parameter name="x">` inside an invoke block', () => {
    const text = `<tool_call><invoke name="run_shell"><parameter name="command">echo hi</parameter></invoke></tool_call>`
    const { toolCalls } = recoverTextToolCalls(text)
    assert.equal(toolCalls.length, 1)
    assert.equal(at(toolCalls, 0).name, 'run_shell')
    assert.equal((at(toolCalls, 0).args as { command: string } | undefined)?.command, 'echo hi')
  })

  it('stripTextToolCallBlocks removes MiniMax delimiters and invoke blocks', () => {
    const text = `Done.]<]minimax[>[<invoke name="run_shell"><command>ls</command></invoke>`
    const stripped = stripTextToolCallBlocks(text)
    assert.equal(stripped, 'Done.')
    assert.ok(!stripped.includes('minimax'))
    assert.ok(!stripped.includes('<invoke'))
  })

  it('stripTextToolCallBlocks holds an unterminated invoke opener while streaming', () => {
    const stripped = stripTextToolCallBlocks(
      'Working on it ]<]minimax[>[<invoke name="run_shell"><command>git fe',
    )
    assert.equal(stripped, 'Working on it')
    assert.ok(!stripped.includes('<invoke'))
    assert.ok(!stripped.includes('minimax'))
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

  // Regression: when the model *explains* the tool-call dialects (e.g. reviewing
  // this parser), it quotes `<tool_call>` / `<invoke>` inside backticks. Those are
  // prose, not openers — they must not freeze the rest of the message, nor be
  // extracted as phantom calls.
  it('stripTextToolCallBlocks keeps a quoted `<tool_call>` example and the prose after it', () => {
    const stripped = stripTextToolCallBlocks(
      'Cursor/Qwen-style: `<tool_call>` blocks. More analysis follows here.',
    )
    assert.ok(stripped.includes('More analysis follows here.'))
    assert.ok(stripped.includes('`<tool_call>`'))
  })

  it('stripTextToolCallBlocks keeps a quoted `<invoke>` example and the prose after it', () => {
    const stripped = stripTextToolCallBlocks(
      'MiniMax: `<invoke name="tool">…</invoke>` blocks (often wrapped in `<tool_call>`). Done.',
    )
    assert.ok(stripped.includes('Done.'))
    assert.ok(stripped.includes('<invoke name="tool">'))
  })

  it('stripTextToolCallBlocks keeps a fenced code-block example intact', () => {
    const stripped = stripTextToolCallBlocks(
      'Example:\n```\n<tool_call>\n<function=run_shell>\n</tool_call>\n```\nThat is the format.',
    )
    assert.ok(stripped.includes('That is the format.'))
    assert.ok(stripped.includes('<tool_call>'))
  })

  it('stripTextToolCallBlocks keeps prose ending in a lone backtick (mid-stream)', () => {
    // The model paused right after opening an inline code span — the dangling
    // backtick is literal text, not a code span, and must not be discarded.
    const stripped = stripTextToolCallBlocks('Cursor/Qwen-style: `')
    assert.ok(stripped.includes('Cursor/Qwen-style:'))
  })

  it('recoverTextToolCalls ignores a `<invoke>` quoted inside a code span', () => {
    const { toolCalls } = recoverTextToolCalls(
      'The parser handles `<invoke name="tool">…</invoke>` blocks.',
    )
    assert.equal(toolCalls.length, 0)
  })

  it('recoverTextToolCalls still recovers a real call after a quoted example', () => {
    const text = `Format is \`<tool_call>\`.

<tool_call>
<function=run_shell>
<parameter=command>ls</parameter>
</function>
</tool_call>`
    const { toolCalls, cleanedText } = recoverTextToolCalls(text)
    assert.equal(toolCalls.length, 1)
    assert.equal(at(toolCalls, 0).name, 'run_shell')
    assert.ok(cleanedText.includes('`<tool_call>`'))
  })

  it('preserves backtick code spans inside a function parameter value (#519 arg corruption)', () => {
    const content = 'Run `npm test` then `npm run build` to finish.'
    const text = `<tool_call>
<function=write_file>
<parameter=path>README.md</parameter>
<parameter=content>${content}</parameter>
</function>
</tool_call>`
    const { toolCalls } = recoverTextToolCalls(text)
    assert.equal(toolCalls.length, 1)
    assert.equal(at(toolCalls, 0).name, 'write_file')
    assert.equal((at(toolCalls, 0).args as { content?: string }).content, content)
  })

  it('preserves backtick code spans inside a bare <invoke> parameter (#519 arg corruption)', () => {
    const command = 'echo `date` && ls'
    const text = `<invoke name="run_shell"><command>${command}</command></invoke>`
    const { toolCalls } = recoverTextToolCalls(text)
    assert.equal(toolCalls.length, 1)
    assert.equal(at(toolCalls, 0).name, 'run_shell')
    assert.equal((at(toolCalls, 0).args as { command?: string }).command, command)
  })
})
