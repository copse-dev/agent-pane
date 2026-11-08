import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { z } from 'zod'
import { defineTool, type LLMProvider } from '@shared/types'
import { runAgent, stopAllAgentRuns } from './agent-service.ts'
import { ToolRegistry, setPermissionGateForTests } from './tool-registry.ts'
import { runWithThreadExecutionContext } from './thread-execution-context.ts'
import { runWithActiveRunIdentity } from './thread-models.ts'
import {
  runShellOnce,
  listForegroundShellProcesses,
  stopAllForegroundShellProcesses,
} from './exec/foreground-shell-process.ts'

it('interrupts the owning turn before a command completion can release a queued file edit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'copse-agent-shutdown-'))
  const threadId = 'shutdown-queued-write'
  const registry = new ToolRegistry()
  let calls = 0
  const provider: LLMProvider = {
    stream: async function* () {
      if (calls++ === 0) {
        yield { type: 'tool_call', toolCall: { id: 'shell', name: 'run_shell', args: {} } }
        yield { type: 'tool_call', toolCall: { id: 'edit', name: 'write_file', args: {} } }
      } else yield { type: 'text', text: 'Finished.' }
      yield { type: 'done' }
    },
  }
  registry.register(
    defineTool({
      name: 'run_shell',
      description: 'Run the owned fixture',
      parameters: z.object({}),
      execute: async (_args, signal) =>
        JSON.stringify(
          await runShellOnce(
            'node -e "setInterval(()=>{},1000)"',
            root,
            30_000,
            signal,
            true,
            process.env,
          ),
        ),
    }),
  )
  registry.register(
    defineTool({
      name: 'write_file',
      description: 'Write the queued fixture',
      parameters: z.object({}),
      execute: async () => {
        await writeFile(join(root, 'after-shutdown.txt'), 'queued edit')
        return 'written'
      },
    }),
  )
  setPermissionGateForTests(async () => true)
  const pending = runWithThreadExecutionContext(
    {
      projectId: 'shutdown-project',
      threadId,
      projectRoot: root,
      root,
      checkoutMode: 'shared',
      branch: 'main',
    },
    () =>
      runWithActiveRunIdentity(threadId, () =>
        runAgent(threadId, 'Run the command, then edit.', [], { emit: () => {} }, registry, {
          provider,
          contextWindow: 100_000,
        }),
      ),
  )
  try {
    const deadline = Date.now() + 10_000
    while (listForegroundShellProcesses().length === 0) {
      assert.ok(Date.now() < deadline, 'fixture command did not start')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    stopAllAgentRuns()
    await stopAllForegroundShellProcesses()
    await pending
    await assert.rejects(access(join(root, 'after-shutdown.txt')), /ENOENT/)
    await assert.rejects(
      runAgent('late-turn', 'Too late', [], { emit: () => {} }, registry, {
        provider,
        contextWindow: 100_000,
      }),
      /closing/,
    )
  } finally {
    await stopAllForegroundShellProcesses()
    await pending.catch(() => {})
    setPermissionGateForTests(null)
    await rm(root, { recursive: true, force: true })
  }
})
