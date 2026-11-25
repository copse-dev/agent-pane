/**
 * The process entry of the local turn worker (`docs/plans/local-turn-worker.md`).
 * Bundled by `scripts/main-bundles.mts` into `dist/main/turn-worker.cjs` and run
 * by the app with its own binary under `ELECTRON_RUN_AS_NODE=1`, detached, when
 * it quits with a turn in flight. Nothing here may import `electron`.
 *
 *   turn-worker.cjs --user-data <dir> --project <id> --thread <id>
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
import { readOnlyProfileStoreFactory } from './read-only-profile-store.ts'

function log(line: string): void {
  process.stderr.write(`[turn-worker ${new Date().toISOString()}] ${line}\n`)
}

async function main(): Promise<number> {
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
    readOnlyProfileStoreFactory(userDataPath, (store, key) => {
      log(`kept a write to ${store}.json "${key}" in memory only`)
    }),
  )
  setSecretCipher(createKeyringCipher(createOsKeyringStore()))

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
    const outcome = await runTurnWorker({ projectId, threadId }, { registry, log })
    log(`thread ${threadId}: ${JSON.stringify(outcome)}`)
    return outcome.status === 'held' ? 2 : 0
  } finally {
    await shutdownMcpServers().catch((error: unknown) => {
      log(`could not stop MCP servers: ${String(error)}`)
    })
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
