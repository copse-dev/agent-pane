import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canRunTodoWorkerInWorktree, runTodoWorkerBatch } from './todo-worker-runner.ts'
import { getAgentExecutionRoot } from './execution-root.ts'
import { ToolRegistry } from './tool-registry.ts'
import { setGitAvailableForTest } from './tool-availability.ts'
import { clearAllowedWorkspaceRootsForTest } from './workspace.ts'
import type { ThreadExecutionContext } from './thread-execution-context.ts'
import type { LLMMessage, LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import type { TodoItem } from '@shared/types/todo.ts'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Copse Test',
      GIT_AUTHOR_EMAIL: 'copse@example.invalid',
      GIT_COMMITTER_NAME: 'Copse Test',
      GIT_COMMITTER_EMAIL: 'copse@example.invalid',
    },
  })
}

async function repository(root: string, name: string): Promise<string> {
  const repo = join(root, name)
  await mkdir(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  await writeFile(join(repo, 'README.md'), 'base\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'initial'])
  return repo
}

/**
 * Provider whose streams track overlap (peak concurrency) and optionally throw
 * when the worker's brief contains `failOn` — how one batch member is made to
 * fail without stubbing internals.
 */
function trackingProvider(observed: {
  inFlight: number
  peak: number
  failOn?: string
  holdUntilInFlight?: number
}): LLMProvider {
  let releaseOverlapWait: (() => void) | undefined
  const overlapReached = new Promise<void>((resolve) => {
    releaseOverlapWait = resolve
  })

  return {
    async *stream(messages: LLMMessage[]): AsyncIterable<ProviderStreamChunk> {
      const brief = messages.find((m) => m.role === 'user')
      if (
        observed.failOn !== undefined &&
        typeof brief?.content === 'string' &&
        brief.content.includes(`Step ${observed.failOn}`)
      ) {
        throw new Error('simulated worker model failure')
      }
      // Counted in try/finally: a for-await consumer finalizes the generator
      // after the terminal chunk, and only a finally block is guaranteed to
      // run then — trailing statements after the last yield are not.
      observed.inFlight += 1
      observed.peak = Math.max(observed.peak, observed.inFlight)
      try {
        const holdUntil = observed.holdUntilInFlight
        if (holdUntil !== undefined) {
          if (observed.inFlight >= holdUntil) releaseOverlapWait?.()
          await Promise.race([overlapReached, new Promise((resolve) => setTimeout(resolve, 500))])
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
        yield { type: 'text', text: 'done' }
        yield { type: 'done' }
      } finally {
        observed.inFlight -= 1
      }
    },
  }
}

function item(id: string): TodoItem {
  return { id, content: `Step ${id}`, status: 'in_progress' as const }
}

function parentContext(projectId: string, threadId: string, root: string): ThreadExecutionContext {
  return Object.freeze({
    projectId,
    threadId,
    projectRoot: root,
    root,
    checkoutMode: 'worktree' as const,
    branch: 'main',
  })
}

describe('runTodoWorkerBatch', () => {
  const cleanups: string[] = []
  let previousRoot: string | undefined

  async function setup(): Promise<{ temp: string; repo: string }> {
    previousRoot = process.env['COPSE_WORKTREES_DIR']
    const temp = await mkdtemp(join(tmpdir(), 'copse-todo-batch-'))
    cleanups.push(temp)
    process.env['COPSE_WORKTREES_DIR'] = join(temp, 'worktrees')
    setGitAvailableForTest(true)
    return { temp, repo: await repository(temp, 'repo') }
  }

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKTREES_DIR']
    else process.env['COPSE_WORKTREES_DIR'] = previousRoot
    previousRoot = undefined
    setGitAvailableForTest(null)
    clearAllowedWorkspaceRootsForTest()
    for (const path of cleanups.splice(0).reverse()) {
      await rm(path, { recursive: true, force: true })
    }
  })

  it('caps concurrency at the semaphore, saturates, and drains every item', async () => {
    const { repo } = await setup()
    const observed = { inFlight: 0, peak: 0, holdUntilInFlight: 2 }

    const results = await runTodoWorkerBatch({
      items: [item('a'), item('b'), item('c'), item('d'), item('e')],
      projectId: 'p1',
      threadId: 't1',
      parentContext: parentContext('p1', 't1', repo),
      provider: trackingProvider(observed),
      registry: new ToolRegistry(),
      contextWindow: 100_000,
      toolSchemaReserve: 0,
      signal: new AbortController().signal,
      parallelism: 2,
    })

    assert.equal(results.length, 5)
    assert.ok(
      results.every((r) => r.ok),
      `all workers should complete: ${JSON.stringify(results.map((r) => r.error))}`,
    )
    assert.ok(observed.peak <= 2, `expected peak concurrency <= 2, saw ${String(observed.peak)}`)
    assert.equal(
      observed.peak,
      2,
      'semaphore should actually saturate while five workers queue behind two slots',
    )
  })

  it('only enables worker worktrees for a clean shared checkout', async () => {
    const { repo } = await setup()
    const shared = parentContext('p1', 't1', repo)
    assert.equal(await canRunTodoWorkerInWorktree(shared), true)

    await writeFile(join(repo, 'dirty.txt'), 'not in HEAD\n')
    assert.equal(await canRunTodoWorkerInWorktree(shared), false)
    assert.equal(
      await canRunTodoWorkerInWorktree({ ...shared, root: join(repo, 'thread-worktree') }),
      false,
    )
  })

  it('isolates a failing worker: siblings still complete and merge branches exist only for them', async () => {
    const { repo } = await setup()
    const observed = { inFlight: 0, peak: 0, failOn: 'boom' }

    const doneItems: string[] = []
    const failedItems: string[] = []
    const results = await runTodoWorkerBatch({
      items: [item('ok1'), item('boom'), item('ok2')],
      projectId: 'p1',
      threadId: 't1',
      parentContext: parentContext('p1', 't1', repo),
      provider: trackingProvider(observed),
      registry: new ToolRegistry(),
      contextWindow: 100_000,
      toolSchemaReserve: 0,
      signal: new AbortController().signal,
      parallelism: 3,
      onItemDone: (i) => doneItems.push(i.id),
      onItemFailed: (i) => failedItems.push(i.id),
    })

    assert.equal(results.length, 3, 'one rejection must not strand siblings')
    assert.deepEqual([...failedItems].sort(), ['boom'])
    assert.deepEqual([...doneItems].sort(), ['ok1', 'ok2'])
    const boomResult = results.find((r) => r.item.id === 'boom')
    assert.ok(boomResult, 'boom entry missing')
    assert.equal(boomResult.ok, false)
    assert.match(boomResult.error ?? '', /simulated worker model failure/)
    // Failed workers carry no branch/sha; successful ones do.
    assert.equal(boomResult.branch, null)
    for (const id of ['ok1', 'ok2']) {
      const entry = results.find((r) => r.item.id === id)
      assert.ok(entry?.branch?.startsWith('copse/todo-worker/'), `${id} produced its branch`)
    }
  })

  it('gives each successful worker a distinct worker branch', async () => {
    const { repo } = await setup()
    const results = await runTodoWorkerBatch({
      items: [item('x1'), item('x2')],
      projectId: 'p1',
      threadId: 't1',
      parentContext: parentContext('p1', 't1', repo),
      provider: trackingProvider({ inFlight: 0, peak: 0 }),
      registry: new ToolRegistry(),
      contextWindow: 100_000,
      toolSchemaReserve: 0,
      signal: new AbortController().signal,
      parallelism: 2,
    })

    const branches: string[] = []
    for (const r of results) {
      if (r.branch !== null) branches.push(r.branch)
    }
    assert.equal(branches.length, 2)
    assert.equal(new Set(branches).size, branches.length, 'each worker gets its own branch')
    assert.ok(branches.every((b) => b.startsWith('copse/todo-worker/')))
  })

  it('runs acceptance checks inside each worker root and retains failed checks', async () => {
    const { repo } = await setup()
    const roots = new Map<string, string>()
    const completions = new Map<string, boolean>()
    const results = await runTodoWorkerBatch({
      items: [item('pass'), item('check-fails')],
      projectId: 'p1',
      threadId: 't1',
      parentContext: parentContext('p1', 't1', repo),
      provider: trackingProvider({ inFlight: 0, peak: 0 }),
      registry: new ToolRegistry(),
      contextWindow: 100_000,
      toolSchemaReserve: 0,
      signal: new AbortController().signal,
      parallelism: 2,
      verifyItem: async (todo) => {
        const root = getAgentExecutionRoot()
        assert.ok(root, 'verification must have a worker execution root')
        roots.set(todo.id, root)
        return todo.id === 'pass'
          ? { passed: true, detail: 'passed' }
          : { passed: false, detail: 'simulated check failure' }
      },
      onItemDone: (todo, passed) => completions.set(todo.id, passed),
    })

    const passed = results.find((entry) => entry.item.id === 'pass')
    const failed = results.find((entry) => entry.item.id === 'check-fails')
    assert.ok(passed && failed)
    assert.equal(passed.ok, true)
    assert.equal(failed.ok, false)
    assert.match(failed.error ?? '', /simulated check failure/)
    assert.equal(completions.get('pass'), true)
    assert.equal(completions.get('check-fails'), false)
    assert.notEqual(roots.get('pass'), repo)
    assert.notEqual(roots.get('check-fails'), repo)
    await assert.rejects(() => access(roots.get('pass') ?? ''))
    assert.doesNotThrow(() => git(roots.get('check-fails') ?? '', ['status', '--short']))
  })
})
