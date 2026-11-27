import type { ToolRegistry } from '../tool-registry.ts'

/**
 * The agent runtime a process outside the app boots before it runs turns: the
 * sandbox, the tool registry with skills, plugins, custom tools and MCP
 * servers, from the same bootstrap steps the app's main process uses. Shared by
 * the per-turn worker and the resident turn host
 * (`docs/plans/local-turn-worker.md`). Nothing here may import `electron`.
 *
 * The profile must already be installed read-only (`worker-profile.ts`), so
 * this module and everything it loads is imported only after that.
 */
export interface WorkerRuntime {
  registry: ToolRegistry
  /**
   * The same teardown as the app's quit: nothing a turn started may outlive the
   * process, since no window lists it and nothing else would stop it. Runs once.
   */
  teardown: () => Promise<void>
  /**
   * Tear down on SIGTERM, SIGHUP and SIGINT, then exit 1. A logout, a shutdown
   * or a `kill` ends the process mid-turn, and its commands must not outlive it.
   * Leases are left unreleased, and the next app settles their threads as
   * interrupted (`foreign-turns.ts`). SIGKILL can't be caught; what it leaves
   * runs on in its own process group, as after a SIGKILL of the app.
   */
  teardownOnSignals: () => void
}

export async function bootWorkerRuntime(log: (line: string) => void): Promise<WorkerRuntime> {
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

  const stop = async (what: string, step: () => Promise<void> | void): Promise<void> => {
    try {
      await step()
    } catch (error) {
      log(`could not stop ${what}: ${String(error)}`)
    }
  }
  let tornDown: Promise<void> | null = null
  const teardown = (): Promise<void> =>
    (tornDown ??= (async (): Promise<void> => {
      await stop('foreground commands', stopAllForegroundShellProcesses)
      await stop('supervised background commands', cancelAllSupervisedBackgroundProcesses)
      await stop('supervised tasks', () => getTaskSupervisor().shutdown())
      await stop('agent sessions', disposeAllAcpSessions)
      await stop('background commands', stopAllBackgroundProcesses)
      await stop('MCP servers', shutdownMcpServers)
      await stop('the sandbox', shutdownProjectSandbox)
    })())

  const teardownOnSignals = (): void => {
    const endings: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGHUP', 'SIGINT']
    for (const signal of endings) {
      process.once(signal, () => {
        log(`${signal}: stopping what the turns started`)
        void teardown().finally(() => {
          process.exit(1)
        })
      })
    }
  }

  return { registry, teardown, teardownOnSignals }
}
