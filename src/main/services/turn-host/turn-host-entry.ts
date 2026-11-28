/**
 * The process entry of the resident turn host (`docs/plans/local-turn-worker.md`,
 * "Every turn in a turn host"). Bundled by `scripts/main-bundles.mts` into
 * `dist/main/turn-host.js` and run by the app with its own binary under
 * `ELECTRON_RUN_AS_NODE=1`, detached, so it outlives the app. Nothing here may
 * import `electron`.
 *
 *   turn-host.js --user-data <dir> [--app-version <v>] [--packaged] [--ready-file <path>]
 *                [--relay-inference] [--commands-unsandboxed]
 *
 * With `--relay-inference` (a worker on an SSH host) every model call is made
 * by the attached app with its own keys (`host-inference-relay.ts`), and with
 * `--commands-unsandboxed` its commands are judged as an SSH project's are.
 *
 * With `--ready-file`, it writes the socket path it serves (or that another
 * host already serves) there once a client can connect: a starter on another
 * machine reads it rather than working the path out for itself.
 *
 * It boots the profile read-only, as the per-turn worker does (decision 4),
 * boots the agent runtime once, and serves the profile's turn-host line until
 * it has had no turn and no app attached for ten minutes.
 *
 * Exit codes: 0 it went idle or retired; 2 another host already serves the
 * profile; 1 it could not start.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { ProfileStoreChange } from '../turn-worker/read-only-profile-store.ts'
import { installReadOnlyProfile } from '../turn-worker/worker-profile.ts'
import { quietWorkerEnvironment } from '../turn-worker/worker-environment.ts'
import { connectTurnHost, turnHostSocketPath } from './turn-host-protocol.ts'
import type { TurnHostDependencies } from './turn-host.ts'
import { HostInferenceRelay } from './host-inference-relay.ts'

function log(line: string): void {
  process.stderr.write(`[turn-host ${new Date().toISOString()}] ${line}\n`)
}

async function main(): Promise<number> {
  quietWorkerEnvironment(process.env)
  const { values } = parseArgs({
    options: {
      'user-data': { type: 'string' },
      'app-version': { type: 'string' },
      packaged: { type: 'boolean', default: false },
      'ready-file': { type: 'string' },
      // On another machine: model calls go to the attached app, which holds the keys.
      'relay-inference': { type: 'boolean', default: false },
      'commands-unsandboxed': { type: 'boolean', default: false },
    },
    strict: true,
  })
  const userDataPath = values['user-data']
  if (!userDataPath) {
    log('usage: turn-host --user-data <dir>')
    return 1
  }
  const version = values['app-version'] ?? 'turn-host'
  const socketPath = turnHostSocketPath(userDataPath)

  // One host per profile. Serving would take the path over from a live one.
  const existing = await connectTurnHost(
    socketPath,
    () => undefined,
    () => undefined,
  )
  const readyFile = values['ready-file']
  const ready = (): void => {
    if (readyFile !== undefined) writeFileSync(readyFile, `${socketPath}\n`, { mode: 0o600 })
  }
  if (existing) {
    existing.close()
    ready()
    log('another host already serves this profile')
    return 2
  }

  // The profile has to be in place before any module that opens a store loads,
  // so everything past this point is imported dynamically.
  // A turn's writes to shared stores go to the app once the host is up (decision 5).
  let forward: (store: string, changes: ProfileStoreChange[]) => void = (store) => {
    log(`kept a boot-time write to ${store}.json in memory only`)
  }
  const profile = await installReadOnlyProfile({
    userDataPath,
    version,
    packaged: values.packaged,
    log,
    onChange: (store, changes) => {
      forward(store, changes)
    },
  })
  const [{ bootWorkerRuntime }, { TurnHost }, { serveTurnHost }, { initSshAskpassServer }] =
    await Promise.all([
      import('../turn-worker/worker-runtime.ts'),
      import('./turn-host.ts'),
      import('./turn-host-protocol.ts'),
      import('../ssh-workspace/askpass.ts'),
    ])
  // The host's own askpass socket, apart from the app's: OpenSSH run by a host
  // turn asks here, and the turn's handler puts the question to the window.
  initSshAskpassServer(join(userDataPath, 'turn-host'))
  const runtime = await bootWorkerRuntime(log)
  const [
    { getWorkspaceRoot, rereadPersistedWorkspaceRoot },
    { initSkillsRegistry },
    { initAgentsRegistry },
    { registerSkillTools },
    { reloadMcpServers },
    { getPluginService },
    { turnHostCapabilities },
  ] = await Promise.all([
    import('../workspace.ts'),
    import('../skills/skills-registry.ts'),
    import('../agents/agents-registry.ts'),
    import('../registry-bootstrap.ts'),
    import('../mcp/mcp-registry.ts'),
    import('../plugins/plugin-service.ts'),
    import('./host-can-run.ts'),
  ])
  // As the app does when its window selects a project or toggles a plugin
  // (workspace-handlers.ts, plugin-handlers.ts).
  const workspaceChanged = async (): Promise<void> => {
    await initSkillsRegistry()
    await initAgentsRegistry()
    registerSkillTools(runtime.registry)
    await reloadMcpServers(runtime.registry).catch((error: unknown) => {
      log(`could not reload MCP servers for the project: ${String(error)}`)
    })
  }
  runtime.teardownOnSignals()
  // A worker on an SSH host judges its commands as the app judges an SSH
  // project's (docs/shell-permissions.md, "SSH workspaces"): no sandbox, so
  // ordinary commands ask first, whatever the host's own sandbox could do.
  if (values['commands-unsandboxed']) {
    const { setProjectSandboxEnabled } = await import('../../project-sandbox/enabled.ts')
    setProjectSandboxEnabled(false)
  }

  const relay = values['relay-inference'] ? new HostInferenceRelay() : undefined
  if (relay !== undefined) {
    const { setInferenceRelay } = await import('../providers/provider-selection.ts')
    setInferenceRelay((model, promptCacheKey, opts) => relay.provider(model, promptCacheKey, opts))
  }

  const done = Promise.withResolvers<undefined>()
  const host = new TurnHost({
    registry: runtime.registry,
    log,
    version,
    capabilities: turnHostCapabilities,
    ...(relay === undefined ? {} : { inferenceRelay: relay }),
    onIdle: (): void => {
      done.resolve(undefined)
    },
    reloadProfile: async (): Promise<void> => {
      const before = getWorkspaceRoot()
      await profile.reload()
      // The app switched projects: what the turns see comes from the new root.
      const pluginsChanged = await getPluginService().applyPersistedEnablement()
      if (rereadPersistedWorkspaceRoot() !== before || pluginsChanged) await workspaceChanged()
    },
    ...(await testScenarioDependency()),
  })
  forward = (store, changes): void => {
    host.storeWrite(store, changes)
  }
  // Background commands: their task records are the app's (H7); their
  // completion wakes run here, where the command's turn ran.
  const [{ installBackgroundProcessSupervisor }, { setBackgroundCompletionWakeHandler }] =
    await Promise.all([
      import('../exec/supervised-background-process.ts'),
      import('../exec/background-completion-wake.ts'),
    ])
  installBackgroundProcessSupervisor(host.tasks)
  const { setLateCommandPhaseRecorder } = await import('../exec/command-phase.ts')
  setLateCommandPhaseRecorder((owner, toolCallId, phase) =>
    host.updateCommandPhase(owner, toolCallId, phase).catch((error: unknown) => {
      log(`could not record a command stage: ${String(error)}`)
    }),
  )
  setBackgroundCompletionWakeHandler((request) => host.runWake(request))
  // Prompts to other threads (a subthread start), which the app's window submits.
  const { setThreadPromptSender } = await import('../thread-prompts.ts')
  setThreadPromptSender((command, signal) => host.threadPrompt(command, signal))
  // Nested instruction activations, which the app's Settings → Sources shows.
  const { setNestedActivationSink } = await import('../project-instructions.ts')
  setNestedActivationSink((projectKey, threadId, names) => {
    host.instructionActivation(projectKey, threadId, names)
  })
  // Live command output, which the app paints into its terminal pane.
  const { setShellOutputSink } = await import('../exec/shell-output-context.ts')
  setShellOutputSink((chunk, taskId) => {
    host.shellOutput(chunk, taskId)
  })
  const server = await serveTurnHost(
    socketPath,
    (message, client) => {
      host.handle(message, client)
    },
    (client) => {
      host.left(client)
    },
  )
  host.bindBroadcast(server.broadcast)
  ready()
  log(`serving ${socketPath} (version ${version}, pid ${String(process.pid)})`)

  try {
    await done.promise
    log('no turns and no app attached: exiting')
    return 0
  } finally {
    host.dispose()
    await server.close()
    await runtime.teardown()
  }
}

/**
 * Host turns claim scripted model responses in this process, so an e2e run's
 * scenarios have to be set here too. Compiled out of release builds.
 */
async function testScenarioDependency(): Promise<Pick<TurnHostDependencies, 'testScenario'>> {
  if (!__COPSE_TEST_SCENARIOS__ || process.env['COPSE_E2E'] !== '1') return {}
  const { runTestScenarioOp } = await import('./turn-host-test-scenarios.ts')
  return { testScenario: runTestScenarioOp }
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
