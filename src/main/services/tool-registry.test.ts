import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { ToolRegistry, setPermissionGateForTests } from './tool-registry.ts'
import { setWorkspaceRootForTest } from './workspace.ts'
import { clearAllSearchResultCachesForTest } from './search/search-result-cache.ts'
import { z } from 'zod'

describe('ToolRegistry', () => {
  it('registers and executes a tool', async () => {
    setPermissionGateForTests(async () => true)
    const reg = new ToolRegistry()
    reg.register({
      name: 'echo',
      description: 'echo args',
      parameters: z.object({ msg: z.string() }),
      execute: async ({ msg }) => msg,
    })
    const result = await reg.execute('echo', { msg: 'hello' }, new AbortController().signal)
    assert.equal(result, 'hello')
    setPermissionGateForTests(null)
  })

  // H2 (docs/plans/hooks-and-feature-packs.md): a toolGate hook's injected
  // context is stamped onto the check by the gate; the runner appends it to the
  // tool result so the model reads it in the current turn.
  it('appends a hook-injected system-reminder block to a string result (H2)', async () => {
    setPermissionGateForTests(async (check) => {
      check.injectContext = '<system-reminder>\nremember this\n</system-reminder>'
      return true
    })
    const reg = new ToolRegistry()
    reg.register({
      name: 'echo',
      description: 'echo args',
      parameters: z.object({ msg: z.string() }),
      execute: async ({ msg }) => msg,
    })
    const result = await reg.execute('echo', { msg: 'output' }, new AbortController().signal)
    assert.equal(result, 'output\n\n<system-reminder>\nremember this\n</system-reminder>')
    setPermissionGateForTests(null)
  })

  it('appends injected context to a structured result, preserving edit stats (H2)', async () => {
    setPermissionGateForTests(async (check) => {
      check.injectContext = '<system-reminder>\nnote\n</system-reminder>'
      return true
    })
    const reg = new ToolRegistry()
    reg.register({
      name: 'edit',
      description: 'edit a file',
      parameters: z.object({ path: z.string() }),
      execute: async () => ({ result: 'edited', editStats: { additions: 2, deletions: 1 } }),
    })
    const result = await reg.execute('edit', { path: 'a.ts' }, new AbortController().signal)
    assert.deepEqual(result, {
      result: 'edited\n\n<system-reminder>\nnote\n</system-reminder>',
      editStats: { additions: 2, deletions: 1 },
    })
    setPermissionGateForTests(null)
  })

  it('leaves the result untouched when no context is injected (H2)', async () => {
    setPermissionGateForTests(async () => true)
    const reg = new ToolRegistry()
    reg.register({
      name: 'echo',
      description: 'echo args',
      parameters: z.object({ msg: z.string() }),
      execute: async ({ msg }) => msg,
    })
    const result = await reg.execute('echo', { msg: 'plain' }, new AbortController().signal)
    assert.equal(result, 'plain')
    setPermissionGateForTests(null)
  })

  describe('search result caching', () => {
    let restoreWorkspace: () => void

    beforeEach(() => {
      restoreWorkspace = setWorkspaceRootForTest('/tmp/tool-registry-cache-test')
      clearAllSearchResultCachesForTest()
    })

    afterEach(() => {
      restoreWorkspace()
      clearAllSearchResultCachesForTest()
    })

    it('reuses a cached result for a repeated search_code call instead of re-executing', async () => {
      setPermissionGateForTests(async () => true)
      const reg = new ToolRegistry()
      let calls = 0
      reg.register({
        name: 'search_code',
        description: 'search',
        parameters: z.object({ pattern: z.string() }),
        execute: async ({ pattern }) => {
          calls++
          return `match for ${pattern} (call ${String(calls)})`
        },
      })
      const signal = new AbortController().signal
      const first = await reg.execute('search_code', { pattern: 'foo' }, signal)
      const second = await reg.execute('search_code', { pattern: 'foo' }, signal)
      assert.equal(calls, 1)
      assert.equal(first, second)
      setPermissionGateForTests(null)
    })

    it('drops the cache once a non-read-only tool runs', async () => {
      setPermissionGateForTests(async () => true)
      const reg = new ToolRegistry()
      let calls = 0
      reg.register({
        name: 'search_code',
        description: 'search',
        parameters: z.object({ pattern: z.string() }),
        execute: async ({ pattern }) => {
          calls++
          return `match for ${pattern} (call ${String(calls)})`
        },
      })
      reg.register({
        name: 'write_file',
        description: 'write',
        parameters: z.object({ path: z.string() }),
        execute: async () => 'written',
      })
      const signal = new AbortController().signal
      await reg.execute('search_code', { pattern: 'foo' }, signal)
      await reg.execute('write_file', { path: 'a.ts' }, signal)
      await reg.execute('search_code', { pattern: 'foo' }, signal)
      assert.equal(calls, 2)
      setPermissionGateForTests(null)
    })
  })

  it('throws on unknown tool', async () => {
    setPermissionGateForTests(async () => true)
    const reg = new ToolRegistry()
    await assert.rejects(
      () => reg.execute('nope', {}, new AbortController().signal),
      /Unknown tool/,
    )
    setPermissionGateForTests(null)
  })

  it('toLLMTools returns JSON Schema shape', () => {
    setPermissionGateForTests(async () => true)
    const reg = new ToolRegistry()
    reg.register({
      name: 'greet',
      description: 'greet',
      parameters: z.object({ name: z.string().describe('person name') }),
      execute: async () => 'hi',
    })
    const tools = reg.toLLMTools()
    assert.equal(tools.length, 1)
    const [tool] = tools
    assert.ok(tool)
    assert.equal(tool.name, 'greet')
    const properties = tool.parameters['properties']
    assert.ok(properties && typeof properties === 'object' && 'name' in properties)
    setPermissionGateForTests(null)
  })
})
