import { describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalizeToolExecuteResult } from '@shared/types'
import { ToolRegistry, setPermissionGateForTests } from '../services/tool-registry.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import {
  retainExploredSpans,
  runWithAgentRunExploreMode,
} from '../services/agent-run-explore-mode.ts'
import { runWithAgentRunReadFileLimits } from '../services/agent-run-read-limits.ts'
import { ownedIt as it } from '../services/thread-execution-context.test-support.ts'
import { readExploredTool } from './read-explored-tool.ts'

const FILE = ['one', '\ttwo  ', 'three', 'four', 'five', 'six', ''].join('\n')

describe('read_explored (#1433 Fix 0b)', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined
  let registry: ToolRegistry

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-read-explored-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    await writeFile(join(tempRoot, 'a.ts'), FILE, 'utf8')
    await writeFile(join(tempRoot, 'unexplored.ts'), 'secret = 1\n', 'utf8')
    registry = new ToolRegistry()
    registry.register(readExploredTool)
    setPermissionGateForTests(async () => true)
  })

  afterEach(async () => {
    setPermissionGateForTests(null)
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  /** One explore-mode run in which an explore subagent read lines 1–3 of a.ts. */
  function inRun(args: Record<string, unknown>, before?: () => Promise<void>): Promise<string> {
    return runWithAgentRunExploreMode(true, () =>
      runWithAgentRunReadFileLimits({ maxLines: 150, maxChars: 12_000 }, async () => {
        retainExploredSpans([
          { path: 'a.ts', startLine: 1, endLine: 3, text: 'one\n\ttwo  \nthree' },
        ])
        await before?.()
        const raw = await registry.execute('read_explored', args, new AbortController().signal)
        return normalizeToolExecuteResult(raw).result
      }),
    )
  }

  it('quotes lines exploration read, byte for byte', async () => {
    const out = await inRun({ path: 'a.ts', start_line: 2, end_line: 3 })
    assert.equal(out, '`a.ts` lines 2–3:\n```\n\ttwo  \nthree\n```')
  })

  it('refuses a path exploration never read rather than reading it from disk', async () => {
    const out = await inRun({ path: 'unexplored.ts' })
    assert.match(out, /^Not explored yet: no explore call in this run read unexplored\.ts\./)
    assert.doesNotMatch(out, /secret/)
  })

  it('names the explored ranges for lines exploration never read', async () => {
    const out = await inRun({ path: 'a.ts', start_line: 5, end_line: 6 })
    assert.match(out, /did not read those lines of a\.ts\. Explored: lines 1–3\./)
    assert.doesNotMatch(out, /five/)
  })

  it('quotes the read part of a wider range and says which lines it left out', async () => {
    const out = await inRun({ path: 'a.ts', start_line: 3, end_line: 5 })
    assert.ok(out.startsWith('`a.ts` line 3:\n```\nthree\n```'))
    assert.match(out, /Not read by exploration, so not quoted: lines 4–5\./)
  })

  it('refuses stale bytes once the file changed after exploration', async () => {
    const out = await inRun({ path: 'a.ts' }, () =>
      writeFile(join(tempRoot, 'a.ts'), FILE.replace('\ttwo  ', 'two'), 'utf8'),
    )
    assert.match(out, /a\.ts has changed since it was explored \(lines 1–3 no longer match\)/)
  })

  it('has nothing to serve outside a run', async () => {
    const raw = await registry.execute(
      'read_explored',
      { path: 'a.ts' },
      new AbortController().signal,
    )
    assert.match(normalizeToolExecuteResult(raw).result, /^Not explored yet/)
  })
})
