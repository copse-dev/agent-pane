/**
 * The process entry of the local turn worker (`docs/plans/local-turn-worker.md`).
 * Bundled by `scripts/main-bundles.mts` into `dist/main/turn-worker.js` and run
 * by the app with its own binary under `ELECTRON_RUN_AS_NODE=1`, detached, when
 * it quits with a turn in flight. Nothing here may import `electron`.
 *
 *   turn-worker.js --user-data <dir> --project <id> --thread <id>
 *                   [--app-version <v>] [--packaged]
 *
 * It boots the profile the way the app's main process does, minus every window
 * and shared-store write: settings and projects are read from the profile's
 * JSON files and never written back (decision 4), API keys open through the
 * keyring cipher (decision 5), and the tool registry is assembled from the same
 * bootstrap steps. Then it continues the one thread and exits.
 *
 * Exit codes: 0 the turn was continued, or there was nothing to continue;
 * 2 the thread is still held by another process; 1 the worker could not start.
 */
import { parseArgs } from 'node:util'
import { createKeyringCipher } from '@copse/store-kit/keyring-cipher.ts'
import { createOsKeyringStore } from '@copse/store-kit/os-keyring.ts'
import { setSecretCipher } from '@copse/store-kit/secret-cipher.ts'
import { setElectronAppRuntime } from '../electron-app-runtime.ts'
import { setPersistentStoreFactory } from '../storage/persistent-store.ts'
import { readOnlyProfileStoreFactory, readProfileStores } from './read-only-profile-store.ts'
import { turnWorkerSocketPath } from './turn-worker-socket.ts'
import type { TakenOverThread, TurnControl } from './turn-worker.ts'
import { quietWorkerEnvironment } from './worker-environment.ts'

function log(line: string): void {
  process.stderr.write(`[turn-worker ${new Date().toISOString()}] ${line}\n`)
}

async function main(): Promise<number> {
  quietWorkerEnvironment(process.env)
  const { values } = parseArgs({
    options: {
      'user-data': { type: 'string' },
      project: { type: 'string' },
      thread: { type: 'string' },
      'app-version': { type: 'string' },
      packaged: { type: 'boolean', default: false },
    },
    strict: true,
  })
  const userDataPath = values['user-data']
  const projectId = values.project
  const threadId = values.thread
  if (!userDataPath || !projectId || !threadId) {
    log('usage: turn-worker --user-data <dir> --project <id> --thread <id>')
    return 1
  }

  // The profile has to be in place before any module that opens a store loads,
  // so everything past this point is imported dynamically.
  setElectronAppRuntime({
    userDataPath,
    version: values['app-version'] ?? 'turn-worker',
    isPackaged: values.packaged,
  })
  setPersistentStoreFactory(
    readOnlyProfileStoreFactory(await readProfileStores(userDataPath), (store, key) => {
      log(`kept a write to ${store}.json "${key}" in memory only`)
    }),
  )
  setSecretCipher(createKeyringCipher(createOsKeyringStore()))

  // Decide before taking the thread or starting the sandbox and MCP servers: a
  // thread left for the next launch must never be held while the worker boots,
  // or an app relaunched meanwhile would follow it instead of continuing it.
  const { openTurnControl, takeOverThread, whyNotContinue } = await import('./turn-worker.ts')
  const reason = await whyNotContinue(projectId, threadId)
  if (reason !== null) {
    log(`thread ${threadId} stays for the next launch: ${reason}`)
    return 0
  }

  // Take the thread before the slow boot below, so an app relaunched meanwhile
  // follows this worker instead of continuing the turn itself, and serve it at
  // once, so a Stop pressed during the boot reaches this worker.
  const takeOver = await takeOverThread({ projectId, threadId }, { log })
  if (takeOver.status === 'held') return 2
  const thread = takeOver.thread
  const control = await openTurnControl(turnWorkerSocketPath(userDataPath, threadId), log)
  try {
    return await bootAndContinue(projectId, threadId, thread, control)
  } finally {
    await control.close()
    await thread.release()
  }
}

async function bootAndContinue(
  projectId: string,
  threadId: string,
  takenOver: TakenOverThread,
  control: TurnControl,
): Promise<number> {
  const [
    { setExecutionAuditSink },
    { recordExecutionObservation },
    { initProjectSandbox, shutdownProjectSandbox },
    { checkToolAvailability },
    registryBootstrap,
    { getPluginService },
    { initSkillsRegistry },
    { initAgentsRegistry },
    { loadCustomTools },
    { loadMcpServers, shutdownMcpServers },
    { stopAllForegroundShellProcesses },
    { cancelAllSupervisedBackgroundProcesses },
    { getTaskSupervisor },
    { disposeAllAcpSessions },
    { stopAllBackgroundProcesses },
    { runTurnWorker },
  ] = await Promise.all([
    import('../execution-runtime/audit.ts'),
    import('../execution-runtime/audit-recorder.ts'),
    import('../../project-sandbox/index.ts'),
    import('../tool-availability.ts'),
    import('../registry-bootstrap.ts'),
    import('../plugins/plugin-service.ts'),
    import('../skills/skills-registry.ts'),
    import('../agents/agents-registry.ts'),
    import('../mcp/custom-tools-registry.ts'),
    import('../mcp/mcp-registry.ts'),
    import('../exec/foreground-shell-process.ts'),
    import('../exec/supervised-background-process.ts'),
    import('../supervisor/task-supervisor.ts'),
    import('../acp/acp-session-pool.ts'),
    import('../exec/background-process.ts'),
    import('./turn-worker.ts'),
  ])

  setExecutionAuditSink(recordExecutionObservation)
  await initProjectSandbox()
  await checkToolAvailability()
  const registry = registryBootstrap.createRegistry()
  registryBootstrap.syncGhTools(registry)
  registryBootstrap.syncCiInvestigatorTools(registry)
  await getPluginService().refreshInstalledPlugins().then(initSkillsRegistry)
  await initAgentsRegistry()
  registryBootstrap.registerSkillTools(registry)
  await loadCustomTools(registry)
  await loadMcpServers(registry)

  try {
    const outcome = await runTurnWorker(
      { projectId, threadId },
      { registry, log, takenOver, control },
    )
    log(`thread ${threadId}: ${JSON.stringify(outcome)}`)
    return outcome.status === 'held' ? 2 : 0
  } finally {
    // The same teardown as the app's quit: nothing the turn started may outlive
    // the worker, since no window lists it and nothing else would stop it.
    const stop = async (what: string, step: () => Promise<void> | void): Promise<void> => {
      try {
        await step()
      } catch (error) {
        log(`could not stop ${what}: ${String(error)}`)
      }
    }
    await stop('foreground commands', stopAllForegroundShellProcesses)
    await stop('supervised background commands', cancelAllSupervisedBackgroundProcesses)
    await stop('supervised tasks', () => getTaskSupervisor().shutdown())
    await stop('agent sessions', disposeAllAcpSessions)
    await stop('background commands', stopAllBackgroundProcesses)
    await stop('MCP servers', shutdownMcpServers)
    await shutdownProjectSandbox()
  }
}

main().then(
  (code) => {
    process.exit(code)
  },
  (error: unknown) => {
    log(
      `could not start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    )
    process.exit(1)
  },
)
