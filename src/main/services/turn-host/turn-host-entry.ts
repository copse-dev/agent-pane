/**
 * The process entry of the resident turn host (`docs/plans/local-turn-worker.md`,
 * "Every turn in a turn host"). Bundled by `scripts/main-bundles.mts` into
 * `dist/main/turn-host.js` and run by the app with its own binary under
 * `ELECTRON_RUN_AS_NODE=1`, detached, so it outlives the app. Nothing here may
 * import `electron`.
 *
 *   turn-host.js --user-data <dir> [--app-version <v>] [--packaged]
 *
 * It boots the profile read-only, as the per-turn worker does (decision 4),
 * boots the agent runtime once, and serves the profile's turn-host line until
 * it has had no turn and no app attached for ten minutes.
 *
 * Exit codes: 0 it went idle or retired; 2 another host already serves the
 * profile; 1 it could not start.
 */
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { ProfileStoreChange } from '../turn-worker/read-only-profile-store.ts'
import { installReadOnlyProfile } from '../turn-worker/worker-profile.ts'
import { quietWorkerEnvironment } from '../turn-worker/worker-environment.ts'
import { connectTurnHost, turnHostSocketPath } from './turn-host-protocol.ts'
import type { TurnHostDependencies } from './turn-host.ts'

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
  if (existing) {
    existing.close()
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
  runtime.teardownOnSignals()

  const done = Promise.withResolvers<undefined>()
  const host = new TurnHost({
    registry: runtime.registry,
    log,
    version,
    onIdle: (): void => {
      done.resolve(undefined)
    },
    reloadProfile: profile.reload,
    ...(await testScenarioDependency()),
  })
  forward = (store, changes): void => {
    host.storeWrite(store, changes)
  }
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
    () => {
      host.left()
    },
  )
  host.bindBroadcast(server.broadcast)
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
