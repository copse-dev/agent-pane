import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import { configureThreadStore } from '@copse/thread-store/environment.ts'
import type { AutomationTriggerEvent, Thread } from '@shared/types'
import { buildAcpAgentApp, type AcpTurnContext } from './acp/acp-agent-server.ts'
import { runAcpSessionPrompt, type AcpClientHandlers } from './acp/acp-client.ts'
import {
  acquireAcpSession,
  disposeAllAcpSessions,
  hasActiveAcpTurn,
} from './acp/acp-session-pool.ts'
import { createAgentInitiatedTurnLease } from './acp/agent-initiated-turn.ts'
import { AgentDispatcher } from './agent-dispatcher.ts'
import { ToolRegistry } from './tool-registry.ts'
import { getAutomationWorktreeReuse } from './automation-worktree-reuse.ts'
import { createAutomationService } from './automations/automation-service.ts'
import { createHeadlessAutomationRun } from './automations/headless-message-assembler.ts'
import {
  parkCompletedPullRequestWorktree,
  recordCreatedPullRequest,
  releaseCompletedAutomationWorktree,
} from './worktree-parking.ts'
import { runWithThreadExecutionContext } from './thread-execution-context.ts'
import { allocateThreadWorktree } from './worktree-manager.ts'
import { beginWorktreeWriter, hasLiveWorktreeWriter } from './worktree-writers.ts'
import { setGitAvailableForTest } from './tool-availability.ts'
import { storageSet } from './storage/storage.ts'
import {
  closeThreadStoreIndexes,
  getThreadMeta,
  loadAgentTurnEpoch,
  loadProjectThreadMetas,
  saveAgentTurnEpoch,
  saveProjectThread,
  updateMeta,
} from './thread-store.ts'
import { TaskSupervisor } from './supervisor/task-supervisor.ts'
import { FileSupervisedTaskStore } from './supervisor/task-store.ts'
import {
  hasBackgroundProcessRecord,
  hasBackgroundProcessesForThread,
  peekBackgroundProcessLogs,
  startBackgroundProcess,
  stopAllBackgroundProcesses,
} from './exec/background-process.ts'
import { __testInjectTerminalSession, destroyAllTerminalSessions } from './exec/terminal-service.ts'

const NOW = Date.parse('2026-11-06T12:00:00Z')
type Activity =
  | 'idle'
  | 'prompt'
  | 'self-resume'
  | 'pending-tool'
  | 'terminal-tool'
  | 'same-root-writer'
  | 'nested-writer'
  | 'ancestor-writer'
  | 'unscoped-writer'
  | 'own-ancestor-terminal'
  | 'completed-native-background'
  | 'late-root-writer'
type Operation = 'handover' | 'cleanup' | 'scheduled-trigger' | 'pr-parking'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Copse Test',
      GIT_AUTHOR_EMAIL: 'copse@example.invalid',
      GIT_COMMITTER_NAME: 'Copse Test',
      GIT_COMMITTER_EMAIL: 'copse@example.invalid',
    },
  }).trim()
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('The controlled ACP update was not delivered')
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

describe('automatic checkout changes preserve pooled ACP work', () => {
  let scratch: string
  let oldWorktrees: string | undefined
  const services: ReturnType<typeof createAutomationService>[] = []
  const supervisors: TaskSupervisor[] = []
  const releases: Array<() => void> = []
  const prompts: Promise<unknown>[] = []

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'copse-acp-automation-'))
    oldWorktrees = process.env['COPSE_WORKTREES_DIR']
    process.env['COPSE_WORKTREES_DIR'] = join(scratch, 'worktrees')
    configureThreadStore({ workspaceRoot: () => join(scratch, 'workspace') })
    setGitAvailableForTest(true)
    storageSet('plugin.copse.automations.storage', [])
  })

  afterEach(async () => {
    for (const release of releases.splice(0)) release()
    destroyAllTerminalSessions()
    await Promise.allSettled(prompts.splice(0))
    stopAllBackgroundProcesses()
    for (const service of services.splice(0)) service.stop()
    for (const supervisor of supervisors.splice(0)) await supervisor.shutdown()
    await disposeAllAcpSessions()
    closeThreadStoreIndexes()
    configureThreadStore()
    if (oldWorktrees === undefined) delete process.env['COPSE_WORKTREES_DIR']
    else process.env['COPSE_WORKTREES_DIR'] = oldWorktrees
    await rm(scratch, { recursive: true, force: true })
  })

  async function scenario(activity: Activity, operation: Operation): Promise<void> {
    const projectId = 'project'
    const previousId = 'previous'
    const nextId = 'next'
    const repo = join(scratch, 'repo')
    await mkdir(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    await writeFile(join(repo, 'README.md'), 'base\n')
    await writeFile(join(repo, '.gitignore'), 'ignored-output/\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'base'])
    if (operation === 'pr-parking') {
      const remote = join(scratch, 'remote.git')
      git(scratch, ['init', '-q', '--bare', remote])
      git(repo, ['remote', 'add', 'origin', remote])
      git(repo, ['push', '-q', '-u', 'origin', 'main'])
    }
    storageSet('projects', [{ id: projectId, path: repo }])
    const supervisor = new TaskSupervisor({
      store: new FileSupervisedTaskStore({ COPSE_WORKSPACE_DIR: join(scratch, 'supervisor') }),
      clock: { now: (): number => NOW, setTimeout: (): number => 0, clearTimeout: (): void => {} },
      cronEnabled: (): boolean => true,
      onError: (): void => {},
    })
    supervisors.push(supervisor)
    const service = createAutomationService({
      now: () => NOW,
      createProjectThread: saveProjectThread,
      releasePreviousRun: releaseCompletedAutomationWorktree,
      canReusePreviousRun: (project, thread) =>
        getAutomationWorktreeReuse().canReusePreviousRun(project, thread),
      isPluginEnabled: () => true,
      supervisor: () => supervisor,
    })
    services.push(service)
    const schedule = await service.upsert(projectId, {
      name: 'Check project',
      cron: '* * * * *',
      prompt: 'Read the project.',
      model: 'controlled-acp',
      enabled: operation === 'scheduled-trigger',
      maxLiveWorktrees: 1,
    })
    const events: AutomationTriggerEvent[] = []
    service.start(
      (event) => events.push(event),
      async () => {
        throw new Error('An active-project draft must not dispatch headlessly')
      },
      () => projectId,
      (_project, thread) => hasActiveAcpTurn(thread),
    )
    await service.sync()
    const worktree = await allocateThreadWorktree({
      projectId,
      threadId: previousId,
      projectRoot: repo,
      prompt: 'Check project',
      baseBranch: 'main',
    })
    const checkpoint = join(
      worktree.path,
      operation === 'pr-parking' ? 'README.md' : 'ignored-output/pending.txt',
    )
    const checkpointContent =
      operation === 'pr-parking' ? 'base\n' : 'Output still owned by background work\n'
    if (operation === 'pr-parking') {
      git(worktree.path, ['push', '-q', '-u', 'origin', worktree.branch])
      worktree.pullRequestUrl = 'https://github.com/example/project/pull/1'
    } else {
      await mkdir(join(worktree.path, 'ignored-output'))
      await writeFile(checkpoint, checkpointContent)
    }
    const previous: Thread = {
      id: previousId,
      title: 'Previous check',
      status: activity === 'prompt' ? 'running' : 'idle',
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: [],
      automation: {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        triggeredAt: NOW - 60_000,
      },
      worktree,
      createdAt: 1,
      updatedAt: 2,
    }
    await saveProjectThread(projectId, previous)
    await saveAgentTurnEpoch(projectId, previousId, {
      turnTreeId: 'original-tree',
      continuationUsed: 0,
    })
    if (operation === 'handover') {
      await saveProjectThread(projectId, {
        id: nextId,
        title: 'Next check',
        status: 'idle',
        usage: { inputTokens: 0, outputTokens: 0 },
        messages: [],
        automation: { scheduleId: schedule.id, scheduleName: schedule.name, triggeredAt: NOW },
        createdAt: 3,
        updatedAt: 3,
      })
    }
    let context: AcpTurnContext | undefined
    let disposed = 0
    const finish = Promise.withResolvers<undefined>()
    const disposalEntered = Promise.withResolvers<undefined>()
    const finishDisposal = Promise.withResolvers<undefined>()
    releases.push(() => {
      finish.resolve(undefined)
    })
    releases.push(() => {
      finishDisposal.resolve(undefined)
    })
    const { entry } = await acquireAcpSession({
      threadId: previousId,
      projectId,
      config: { command: 'controlled-loopback', cwd: worktree.path },
      createTransport: async () => {
        const c2a = new TransformStream<Uint8Array, Uint8Array>()
        const a2c = new TransformStream<Uint8Array, Uint8Array>()
        const connection = buildAcpAgentApp(async (ctx) => {
          context = ctx
          if (activity === 'pending-tool' || activity === 'terminal-tool') {
            await ctx.emit({
              type: 'tool_call',
              toolCall: { id: 'background-helper', name: 'background-helper', args: {} },
            })
          }
          if (activity === 'terminal-tool') {
            await ctx.emit({
              type: 'tool_result',
              toolCallId: 'background-helper',
              result: 'Done',
              isError: false,
            })
          }
          if (activity === 'prompt') await finish.promise
          return { stopReason: 'end_turn' }
        }).connect(ndJsonStream(a2c.writable, c2a.readable))
        return {
          stream: ndJsonStream(c2a.writable, a2c.readable),
          dispose: async (): Promise<void> => {
            disposed++
            connection.close()
            if (activity === 'late-root-writer') {
              disposalEntered.resolve(undefined)
              await finishDisposal.promise
            }
          },
        }
      },
    })
    const dispatcher = new AgentDispatcher({ emit: (): void => {} }, new ToolRegistry())
    const lease = createAgentInitiatedTurnLease({
      projectId,
      threadId: previousId,
      bridge: {
        setExecutionContext: () => {},
        setPendingExecutionContext: () => {},
        setTurnSignal: () => {},
      },
      resolveContext: async () => ({ root: worktree.path }),
      confirmContinue: async () => false,
      beginWriter: () => beginWorktreeWriter(worktree.path),
      getAuthority: () => dispatcher,
    })
    releases.push(lease.end)
    entry.open.agentInitiated = lease
    const headless = createHeadlessAutomationRun(projectId, previousId)
    await headless.appendUserMessage('Read the project and keep background work safe.')
    entry.open.handlers.current = {
      onChunk: (chunk): void => {
        headless.host.emit(previousId, chunk)
      },
      requestPermission: async (): ReturnType<AcpClientHandlers['requestPermission']> => ({
        outcome: { outcome: 'cancelled' },
      }),
    }
    const prompt = runAcpSessionPrompt(entry.open, 'Read project', undefined)
    // Keep a deliberately reproduced close failure observed until teardown;
    // the scenario still awaits the original prompt and asserts ownership.
    prompts.push(
      prompt.then(
        (): undefined => undefined,
        (): undefined => undefined,
      ),
    )
    if (activity === 'prompt') await until(() => context !== undefined)
    else {
      await prompt
      headless.host.emit(previousId, { type: 'done' })
      await headless.flush()
    }
    if (activity === 'self-resume') {
      assert.ok(context)
      await context.emit({ type: 'text', text: 'A background task resumed this agent.' })
      await until(lease.isActive)
      for (let attempts = 0; attempts < 200; attempts++) {
        if ((await loadAgentTurnEpoch(projectId, previousId))?.continuationUsed === 1) break
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      await until(() => hasLiveWorktreeWriter(worktree.path))
    }
    if (activity === 'same-root-writer') releases.push(beginWorktreeWriter(worktree.path))
    if (activity === 'nested-writer') {
      releases.push(beginWorktreeWriter(join(worktree.path, 'packages', 'app')))
    }
    // `scratch` holds the worktrees directory, as the home directory holds
    // ~/.copse/worktrees: a shell there, or an MCP call (unscoped), contains
    // every checkout and so is no evidence that this one is in use.
    if (activity === 'ancestor-writer') releases.push(beginWorktreeWriter(scratch))
    if (activity === 'unscoped-writer') releases.push(beginWorktreeWriter(null))
    if (activity === 'own-ancestor-terminal') {
      // This thread's own local terminal, which starts in the home directory.
      __testInjectTerminalSession({
        ownerId: 1,
        label: 'Local',
        threadId: previousId,
        outputText: '',
      })
      releases.push(beginWorktreeWriter(scratch))
    }
    if (activity === 'completed-native-background') {
      const completed = Promise.withResolvers<undefined>()
      const owner = { projectId, threadId: previousId }
      const background = await startBackgroundProcess({
        command: 'node -e "process.stdout.write(\'completed-native-job\')"',
        cwd: worktree.path,
        waitMs: 10,
        owner,
        onCompletion: async () => {
          await Promise.resolve()
          completed.resolve(undefined)
        },
      })
      await completed.promise
      await until(() => !hasLiveWorktreeWriter(worktree.path))
      assert.equal(hasBackgroundProcessesForThread(owner), false)
      assert.equal(hasBackgroundProcessRecord(owner), true)
      assert.ok(
        peekBackgroundProcessLogs(background.id, owner)?.logs.includes('completed-native-job'),
      )
    }
    await headless.flush()
    const shouldProtect =
      activity !== 'idle' &&
      activity !== 'terminal-tool' &&
      activity !== 'ancestor-writer' &&
      activity !== 'unscoped-writer' &&
      activity !== 'completed-native-background'
    assert.equal(
      (await getThreadMeta(projectId, previousId))?.status,
      activity === 'prompt' ? 'running' : 'idle',
    )
    assert.equal(dispatcher.isActive(projectId, previousId), false)
    const changeCheckout = async (): Promise<void> => {
      if (operation === 'handover') {
        assert.equal(
          await getAutomationWorktreeReuse().canReusePreviousRun(projectId, previousId),
          !shouldProtect || activity === 'late-root-writer',
        )
        const result = await getAutomationWorktreeReuse().reuseFor({
          projectId,
          threadId: nextId,
          projectRoot: repo,
          baseBranch: 'main',
        })
        assert.equal(result !== null, !shouldProtect)
      } else if (operation === 'cleanup') {
        const result = await service.cleanupRuns(projectId, schedule.id)
        assert.deepEqual(result.released, shouldProtect ? [] : [previousId])
        if (activity !== 'prompt')
          assert.equal(result.retained[0]?.reason, shouldProtect ? 'in-use' : undefined)
      } else if (operation === 'pr-parking') {
        await parkCompletedPullRequestWorktree(projectId, previousId)
        assert.equal(
          (await getThreadMeta(projectId, previousId))?.worktree?.retiredAt !== undefined,
          !shouldProtect,
        )
      } else {
        await service.tick(NOW)
        const created = (await loadProjectThreadMetas(projectId)).filter(
          (thread) => thread.id !== previousId,
        )
        assert.equal(created.length, shouldProtect ? 0 : 1)
        if (shouldProtect && activity !== 'prompt') {
          assert.ok(events.some((event) => event.coalescedReason === 'worktree-limit'))
        }
      }
    }
    if (activity === 'late-root-writer') {
      const changing = changeCheckout()
      await disposalEntered.promise
      releases.push(beginWorktreeWriter(worktree.path))
      finishDisposal.resolve(undefined)
      await changing
    } else await changeCheckout()
    const sessionReleased = !shouldProtect || activity === 'late-root-writer'
    assert.equal(disposed, sessionReleased ? 1 : 0)
    assert.equal(entry.open.isClosed(), sessionReleased)
    assert.equal(await exists(checkpoint), shouldProtect)
    if (shouldProtect) assert.equal(await readFile(checkpoint, 'utf8'), checkpointContent)
    assert.deepEqual(await loadAgentTurnEpoch(projectId, previousId), {
      turnTreeId: 'original-tree',
      continuationUsed: activity === 'self-resume' ? 1 : 0,
    })
    finish.resolve(undefined)
    await prompt
  }

  for (const block of ['running', 'draft'] satisfies Array<'running' | 'draft'>) {
    it(`remembers a created PR across a ${block} parking recheck until the thread becomes idle`, async () => {
      const projectId = `created-pr-${block}`
      const threadId = 'created-pr'
      const repo = join(scratch, 'created-pr-repo')
      const remote = join(scratch, 'created-pr-remote.git')
      await mkdir(repo)
      git(repo, ['init', '-q', '-b', 'main'])
      await writeFile(join(repo, 'README.md'), 'Pull request work\n')
      git(repo, ['add', '.'])
      git(repo, ['commit', '-q', '-m', 'base'])
      git(scratch, ['init', '-q', '--bare', remote])
      git(repo, ['remote', 'add', 'origin', remote])
      git(repo, ['push', '-q', '-u', 'origin', 'main'])
      storageSet('projects', [{ id: projectId, path: repo }])
      const worktree = await allocateThreadWorktree({
        projectId,
        threadId,
        projectRoot: repo,
        prompt: 'Create a pull request',
        baseBranch: 'main',
      })
      git(worktree.path, ['push', '-q', '-u', 'origin', worktree.branch])
      await saveProjectThread(projectId, {
        id: threadId,
        title: 'Created pull request',
        status: block === 'running' ? 'running' : 'idle',
        draftPrompt: block === 'draft' ? 'An unsent next step' : '',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        worktree,
        createdAt: 1,
        updatedAt: 2,
      })
      let disposed = 0
      const { entry } = await acquireAcpSession({
        projectId,
        threadId,
        config: { command: 'controlled-created-pr', cwd: worktree.path },
        createTransport: async () => {
          const c2a = new TransformStream<Uint8Array, Uint8Array>()
          const a2c = new TransformStream<Uint8Array, Uint8Array>()
          const connection = buildAcpAgentApp(async () => ({ stopReason: 'end_turn' })).connect(
            ndJsonStream(a2c.writable, c2a.readable),
          )
          return {
            stream: ndJsonStream(c2a.writable, a2c.readable),
            dispose: async (): Promise<void> => {
              disposed++
              connection.close()
            },
          }
        },
      })
      const url = 'https://github.com/example/project/pull/1'
      runWithThreadExecutionContext(
        {
          projectId,
          threadId,
          projectRoot: repo,
          root: worktree.path,
          checkoutMode: 'worktree',
          branch: worktree.branch,
        },
        () => {
          recordCreatedPullRequest('gh pr create --title "Created pull request"', `${url}\n`)
        },
      )

      await parkCompletedPullRequestWorktree(projectId, threadId)
      assert.equal((await getThreadMeta(projectId, threadId))?.worktree?.pullRequestUrl, undefined)
      assert.equal((await getThreadMeta(projectId, threadId))?.worktree?.retiredAt, undefined)
      assert.equal(await exists(worktree.path), true)
      assert.equal(disposed, 0)
      assert.equal(entry.open.isClosed(), false)

      await updateMeta(projectId, threadId, { status: 'idle', draftPrompt: '' })
      await parkCompletedPullRequestWorktree(projectId, threadId)
      const retired = await getThreadMeta(projectId, threadId)
      assert.equal(retired?.worktree?.pullRequestUrl, url)
      assert.ok(retired.worktree.retiredAt)
      assert.equal(await exists(worktree.path), false)
      assert.equal(disposed, 1)
      assert.equal(entry.open.isClosed(), true)
    })
  }

  for (const operation of [
    'handover',
    'cleanup',
    'scheduled-trigger',
    'pr-parking',
  ] satisfies Operation[]) {
    for (const activity of [
      'idle',
      'prompt',
      'self-resume',
      'pending-tool',
      'terminal-tool',
      'same-root-writer',
      'nested-writer',
      'ancestor-writer',
      'unscoped-writer',
      'own-ancestor-terminal',
      'completed-native-background',
      'late-root-writer',
    ] satisfies Activity[]) {
      it(`${operation} respects ${activity} ownership after prompt completion`, async () => {
        await scenario(activity, operation)
      })
    }
  }
})
