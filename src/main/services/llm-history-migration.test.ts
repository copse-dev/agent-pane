import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LLMMessage, Thread } from '@shared/types'
import {
  LLM_HISTORY_KEY_PREFIX,
  migrateLlmHistory,
  type LlmHistoryMigrationDeps,
} from './llm-history-migration.ts'
import {
  agentHistoryExists,
  findThreadOwners,
  loadAgentHistory,
  saveAgentHistory,
  saveProjectThread,
} from './thread-store.ts'

function userMsg(content: string): LLMMessage {
  return { role: 'user', content }
}

function thread(id: string): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [{ id: `${id}-u`, role: 'user', content: 'hi', toolCalls: [], createdAt: 1 }],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

function memoryDeps(seed: Record<string, unknown> = {}): {
  deps: LlmHistoryMigrationDeps
  data: Map<string, unknown>
  deleteKeysCalls: number[]
  warnings: string[]
} {
  const data = new Map<string, unknown>(Object.entries(seed))
  const deleteKeysCalls: number[] = []
  const warnings: string[] = []
  const deps: LlmHistoryMigrationDeps = {
    listLegacyKeys: () => [...data.keys()].filter((key) => key.startsWith(LLM_HISTORY_KEY_PREFIX)),
    getLegacy: (key) => data.get(key),
    deleteLegacyKeys: (keys) => {
      deleteKeysCalls.push(keys.length)
      for (const key of keys) data.delete(key)
    },
    findOwners: findThreadOwners,
    historyExists: agentHistoryExists,
    saveHistory: saveAgentHistory,
    warn: (message) => {
      warnings.push(message)
    },
  }
  return { deps, data, deleteKeysCalls, warnings }
}

describe('llm-history-migration (#993)', () => {
  let workspace: string
  let prevWorkspace: string | undefined

  beforeEach(() => {
    prevWorkspace = process.env['COPSE_WORKSPACE_DIR']
    workspace = mkdtempSync(join(tmpdir(), 'copse-llm-hist-mig-'))
    process.env['COPSE_WORKSPACE_DIR'] = workspace
  })

  afterEach(() => {
    if (prevWorkspace === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = prevWorkspace
    rmSync(workspace, { recursive: true, force: true })
  })

  it('is a no-op when there are no legacy keys', async () => {
    const { deps, deleteKeysCalls } = memoryDeps()
    const result = await migrateLlmHistory(deps)
    assert.deepEqual(result, {
      scanned: 0,
      migrated: 0,
      skippedExistingSidecar: 0,
      skippedNull: 0,
      ambiguousOwners: 0,
      missingOwners: 0,
      legacyKeysRemoved: 0,
    })
    assert.deepEqual(deleteKeysCalls, [])
  })

  it('migrates a uniquely owned key into agent-history.json and removes it in one rewrite', async () => {
    await saveProjectThread('proj-1', thread('t1'))
    const history = [userMsg('hello'), { role: 'assistant', content: 'hi' } satisfies LLMMessage]
    const { deps, data, deleteKeysCalls, warnings } = memoryDeps({
      [`${LLM_HISTORY_KEY_PREFIX}t1`]: history,
      projects: [{ id: 'proj-1' }],
    })

    const result = await migrateLlmHistory(deps)
    assert.equal(result.migrated, 1)
    assert.equal(result.legacyKeysRemoved, 1)
    assert.deepEqual(deleteKeysCalls, [1], 'exactly one bulk legacy rewrite')
    assert.equal(data.has(`${LLM_HISTORY_KEY_PREFIX}t1`), false)
    assert.deepEqual(data.get('projects'), [{ id: 'proj-1' }])
    assert.deepEqual(await loadAgentHistory('proj-1', 't1'), history)
    assert.deepEqual(warnings, [])
  })

  it('leaves keys with zero owners in legacy storage and warns metadata-only', async () => {
    const { deps, data, deleteKeysCalls, warnings } = memoryDeps({
      [`${LLM_HISTORY_KEY_PREFIX}orphan`]: [userMsg('x')],
    })
    const result = await migrateLlmHistory(deps)
    assert.equal(result.missingOwners, 1)
    assert.equal(result.migrated, 0)
    assert.deepEqual(deleteKeysCalls, [])
    assert.ok(data.has(`${LLM_HISTORY_KEY_PREFIX}orphan`))
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /no owner for thread orphan/)
    assert.doesNotMatch(warnings[0] ?? '', /hello|content|userMsg/)
  })

  it('leaves keys with multiple owners in legacy storage', async () => {
    await saveProjectThread('proj-a', thread('shared'))
    await saveProjectThread('proj-b', thread('shared'))
    const { deps, data, deleteKeysCalls, warnings } = memoryDeps({
      [`${LLM_HISTORY_KEY_PREFIX}shared`]: [userMsg('dup')],
    })
    const result = await migrateLlmHistory(deps)
    assert.equal(result.ambiguousOwners, 1)
    assert.equal(result.migrated, 0)
    assert.deepEqual(deleteKeysCalls, [])
    assert.ok(data.has(`${LLM_HISTORY_KEY_PREFIX}shared`))
    assert.match(warnings[0] ?? '', /ambiguous owners for thread shared/)
  })

  it('does not overwrite an existing sidecar after interruption; still removes the legacy key', async () => {
    await saveProjectThread('proj-1', thread('t1'))
    await saveAgentHistory('proj-1', 't1', [userMsg('already migrated / fresher')])
    const { deps, data, deleteKeysCalls } = memoryDeps({
      [`${LLM_HISTORY_KEY_PREFIX}t1`]: [userMsg('stale legacy')],
    })

    const result = await migrateLlmHistory(deps)
    assert.equal(result.skippedExistingSidecar, 1)
    assert.equal(result.migrated, 0)
    assert.deepEqual(deleteKeysCalls, [1])
    assert.equal(data.has(`${LLM_HISTORY_KEY_PREFIX}t1`), false)
    assert.deepEqual(await loadAgentHistory('proj-1', 't1'), [
      userMsg('already migrated / fresher'),
    ])
  })

  it('removes null placeholder keys without writing a sidecar', async () => {
    await saveProjectThread('proj-1', thread('t1'))
    const { deps, data, deleteKeysCalls } = memoryDeps({
      [`${LLM_HISTORY_KEY_PREFIX}t1`]: null,
    })
    const result = await migrateLlmHistory(deps)
    assert.equal(result.skippedNull, 1)
    assert.equal(result.migrated, 0)
    assert.deepEqual(deleteKeysCalls, [1])
    assert.equal(data.has(`${LLM_HISTORY_KEY_PREFIX}t1`), false)
    assert.equal(await agentHistoryExists('proj-1', 't1'), false)
  })

  it('is idempotent across repeated execution', async () => {
    await saveProjectThread('proj-1', thread('t1'))
    const { deps, data, deleteKeysCalls } = memoryDeps({
      [`${LLM_HISTORY_KEY_PREFIX}t1`]: [userMsg('once')],
    })
    const first = await migrateLlmHistory(deps)
    assert.equal(first.migrated, 1)
    const second = await migrateLlmHistory(deps)
    assert.equal(second.scanned, 0)
    assert.equal(second.migrated, 0)
    assert.deepEqual(deleteKeysCalls, [1])
    assert.equal(data.size, 0)
    assert.deepEqual(await loadAgentHistory('proj-1', 't1'), [userMsg('once')])
  })

  it('migrates many keys with a single legacy rewrite', async () => {
    await saveProjectThread('proj-1', thread('t1'))
    await saveProjectThread('proj-1', thread('t2'))
    await saveProjectThread('proj-2', thread('t3'))
    const { deps, deleteKeysCalls } = memoryDeps({
      [`${LLM_HISTORY_KEY_PREFIX}t1`]: [userMsg('1')],
      [`${LLM_HISTORY_KEY_PREFIX}t2`]: [userMsg('2')],
      [`${LLM_HISTORY_KEY_PREFIX}t3`]: [userMsg('3')],
    })
    const result = await migrateLlmHistory(deps)
    assert.equal(result.migrated, 3)
    assert.equal(result.legacyKeysRemoved, 3)
    assert.deepEqual(deleteKeysCalls, [3], 'one rewrite removing all three keys')
  })
})
