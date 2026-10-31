import { describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { LLMProvider, ProviderStreamChunk } from '@shared/types'
import { ToolRegistry, setPermissionGateForTests } from './tool-registry.ts'
import { readFileTool } from '../tools/file-tools.ts'
import { setWorkspaceRootForTest } from './workspace.ts'
import { runExploreSubagent, type ExploreSubagentResult } from './subagent-service.ts'
import { ownedIt as it } from './thread-execution-context.test-support.ts'
import { EXPLORE_EXCERPTS_HEADING } from '@copse/agent/explore-excerpts.ts'

/** Replays one scripted stream per provider call: tool calls first, then the summary. */
function scriptedProvider(turns: ProviderStreamChunk[][]): LLMProvider {
  let call = 0
  return {
    async *stream(): AsyncGenerator<ProviderStreamChunk> {
      const turn = turns[Math.min(call++, turns.length - 1)] ?? []
      for (const chunk of turn) yield chunk
    },
  }
}

function readCall(id: string, args: Record<string, unknown>): ProviderStreamChunk[] {
  return [{ type: 'tool_call', toolCall: { id, name: 'read_file', args } }, { type: 'done' }]
}

/** Every fenced block in `text`, as `{ header, body }` with the body exactly as fenced. */
function fencedExcerpts(text: string): { header: string; body: string }[] {
  const out: { header: string; body: string }[] = []
  const re = /^(`[^`\n]+` lines? [^\n]+):\n(`{3,})\n([\s\S]*?)\n\2$/gm
  for (const m of text.matchAll(re)) out.push({ header: m[1] ?? '', body: m[3] ?? '' })
  return out
}

function lfLines(absPath: string, start: number, end: number): string {
  return readFileSync(absPath, 'utf8')
    .split('\n')
    .slice(start - 1, end)
    .join('\n')
}

const A_TS = [
  'export function wireToolbar(urlInput: HTMLInputElement): void {',
  "  urlInput.addEventListener('keydown', (event) => {",
  "    if (event.key === 'Enter') {",
  '\t\tsubmitUrl(urlInput.value)  ',
  '    }',
  '  })',
  '}',
  '',
].join('\n')

const B_TS = ['const a = 1', 'const fence = "```"', 'const b = 2', ''].join('\n')

describe('runExploreSubagent structured returns (#1433 Fix 0)', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined
  let registry: ToolRegistry

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-explore-excerpts-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    await writeFile(join(tempRoot, 'a.ts'), A_TS, 'utf8')
    await writeFile(join(tempRoot, 'b.ts'), B_TS, 'utf8')
    registry = new ToolRegistry()
    registry.register(readFileTool)
    setPermissionGateForTests(async () => true)
  })

  afterEach(async () => {
    setPermissionGateForTests(null)
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  function explore(
    turns: ProviderStreamChunk[][],
    contextWindow = 200_000,
  ): Promise<ExploreSubagentResult> {
    return runExploreSubagent({
      parentToolCallId: 'parent-explore',
      query: 'How does wireToolbar submit the url?',
      parentGoal: 'Change the Enter handler',
      provider: scriptedProvider(turns),
      registry,
      contextWindow,
      toolSchemaReserve: 0,
      signal: new AbortController().signal,
      onChunk: () => {},
      usageModel: 'test-model',
    })
  }

  it('returns the summary plus one byte-exact excerpt per file read', async () => {
    const result = await explore([
      readCall('r1', { path: 'a.ts', start_line: 2, end_line: 6 }),
      readCall('r2', { path: 'b.ts' }),
      [{ type: 'text', text: 'wireToolbar in a.ts lines 1-7 submits on Enter.' }, { type: 'done' }],
    ])

    assert.equal(result.summary, 'wireToolbar in a.ts lines 1-7 submits on Enter.')
    assert.ok(result.text.startsWith(result.summary))
    assert.ok(result.text.includes(EXPLORE_EXCERPTS_HEADING))
    const excerpts = fencedExcerpts(result.text)
    assert.deepEqual(
      excerpts.map((e) => e.header),
      ['`a.ts` lines 2–6', '`b.ts` lines 1–3'],
    )
    // The property the plan turns on: excerpt bytes equal the file's bytes,
    // tabs, trailing spaces and embedded backtick fences included.
    assert.equal(excerpts[0]?.body, lfLines(join(tempRoot, 'a.ts'), 2, 6))
    assert.equal(excerpts[1]?.body, lfLines(join(tempRoot, 'b.ts'), 1, 3))
  })

  it('merges overlapping reads of one file into a single verbatim span', async () => {
    const result = await explore([
      readCall('r1', { path: 'a.ts', start_line: 1, end_line: 3 }),
      readCall('r2', { path: 'a.ts', start_line: 2, end_line: 5 }),
      [{ type: 'text', text: 'See a.ts.' }, { type: 'done' }],
    ])
    const excerpts = fencedExcerpts(result.text)
    assert.deepEqual(
      excerpts.map((e) => e.header),
      ['`a.ts` lines 1–5'],
    )
    assert.equal(excerpts[0]?.body, lfLines(join(tempRoot, 'a.ts'), 1, 5))
  })

  it('returns the bare summary when the subagent read nothing', async () => {
    const result = await explore([[{ type: 'text', text: 'Nothing to read.' }, { type: 'done' }]])
    assert.equal(result.text, 'Nothing to read.')
  })

  it('records no excerpt for a single line the char cap may have cut short', async () => {
    // A small context window floors the subagent's read cap at 3,000 chars.
    await writeFile(join(tempRoot, 'long.ts'), `${'x'.repeat(5_000)}\nshort\n`, 'utf8')
    const result = await explore(
      [
        readCall('r1', { path: 'long.ts' }),
        [{ type: 'text', text: 'long.ts is one long line.' }, { type: 'done' }],
      ],
      4_000,
    )
    assert.equal(result.text, 'long.ts is one long line.')
  })

  it('records no excerpt for a failed read', async () => {
    const result = await explore([
      readCall('r1', { path: 'missing.ts' }),
      [{ type: 'text', text: 'missing.ts does not exist.' }, { type: 'done' }],
    ])
    assert.equal(result.text, 'missing.ts does not exist.')
  })
})
