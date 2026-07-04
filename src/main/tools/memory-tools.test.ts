import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { setKnowledgeRootForTest } from '../services/storage/knowledge-store.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import { recallTool, rememberTool, setLegacyMemoriesRootForTest } from './memory-tools.ts'

const noSignal = new AbortController().signal

async function run(tool: typeof rememberTool | typeof recallTool, args: unknown): Promise<string> {
  const result = await tool.execute(tool.parameters.parse(args) as never, noSignal)
  return typeof result === 'string' ? result : result.result
}

describe('memory-tools', () => {
  let knowledgeRoot: string
  let legacyRoot: string
  let restoreWorkspace: () => void

  beforeEach(() => {
    knowledgeRoot = mkdtempSync(join(tmpdir(), 'knowledge-'))
    legacyRoot = mkdtempSync(join(tmpdir(), 'legacy-memories-'))
    setKnowledgeRootForTest(knowledgeRoot)
    setLegacyMemoriesRootForTest(legacyRoot)
    restoreWorkspace = setWorkspaceRootForTest('/home/dev/proj')
  })

  afterEach(() => {
    setKnowledgeRootForTest(null)
    setLegacyMemoriesRootForTest(null)
    restoreWorkspace()
    rmSync(knowledgeRoot, { recursive: true, force: true })
    rmSync(legacyRoot, { recursive: true, force: true })
  })

  it('remember persists and recall returns the note', async () => {
    const saved = await run(rememberTool, {
      title: 'Lint',
      content: 'Run eslint with --fix',
      tags: ['lint'],
    })
    assert.match(saved, /Saved memory "Lint"/)

    const all = await run(recallTool, {})
    assert.match(all, /Found 1 memory/)
    assert.match(all, /## Lint \[lint\]/)
    assert.match(all, /Run eslint with --fix/)
  })

  it('re-using a title updates the memory instead of duplicating it', async () => {
    await run(rememberTool, { title: 'Build', content: 'old body' })
    await run(rememberTool, { title: 'Build', content: 'new body' })

    const all = await run(recallTool, {})
    assert.match(all, /Found 1 memory/)
    assert.match(all, /new body/)
    assert.doesNotMatch(all, /old body/)
  })

  it('recall filters by query and reports no matches', async () => {
    await run(rememberTool, { title: 'Auth', content: 'oauth tokens' })
    await run(rememberTool, { title: 'Cache', content: 'redis layer' })

    const hit = await run(recallTool, { query: 'redis' })
    assert.match(hit, /## Cache/)
    assert.doesNotMatch(hit, /## Auth/)

    const miss = await run(recallTool, { query: 'graphql' })
    assert.match(miss, /No memories match "graphql"/)
  })

  it('recall on an empty project explains how to add one', async () => {
    const empty = await run(recallTool, {})
    assert.match(empty, /No memories stored yet/)
  })

  it('imports legacy ~/.copse/memories notes on first use', async () => {
    // Seed a legacy OKF note in the same slug+hash namespace the store uses
    // (slug(basename) + '-' + sha1(root).slice(0,8)) so the migration finds it.
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha1').update('/home/dev/proj').digest('hex').slice(0, 8)
    const dir = join(legacyRoot, `proj-${hash}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'deploy.md'),
      '---\ntype: Memory\ntitle: "Deploy steps"\ntags: [ops, deploy]\n---\n\nRun the release script.\n',
      'utf8',
    )

    const all = await run(recallTool, {})
    assert.match(all, /## Deploy steps \[ops, deploy\]/)
    assert.match(all, /Run the release script\./)
  })
})
