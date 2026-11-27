/**
 * The process entry of a container run's host side (`run-host.ts`). Bundled by
 * `scripts/main-bundles.mts` into `dist/main/container-run-host.js` and started
 * by the app with its own binary under `ELECTRON_RUN_AS_NODE=1`, detached, once
 * per run. Nothing here may import `electron`.
 *
 *   container-run-host.js --user-data <dir> --request <file>
 *                         [--app-version <v>] [--packaged]
 *
 * The request file holds the run's plain inputs, written by the app for this
 * process alone; it is read once and removed. The profile is booted read-only,
 * as the turn worker boots it, so the provider can be resolved here.
 *
 * Exit codes: 0 the run ended (finished or failed, as its record says);
 * 1 the host could not start.
 */
import { readFile, rm } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { installReadOnlyProfile } from '../turn-worker/worker-profile.ts'
import { containerRunHostRequestSchema, runHostFilePath, runHostSocketPath } from './run-host.ts'

function log(line: string): void {
  process.stderr.write(`[container-run-host ${new Date().toISOString()}] ${line}\n`)
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'user-data': { type: 'string' },
      request: { type: 'string' },
      'app-version': { type: 'string' },
      packaged: { type: 'boolean', default: false },
    },
    strict: true,
  })
  const userDataPath = values['user-data']
  const requestFile = values.request
  if (!userDataPath || !requestFile) {
    log('usage: container-run-host --user-data <dir> --request <file>')
    return 1
  }
  const raw = await readFile(requestFile, 'utf8')
  await rm(requestFile, { force: true })
  const request = safeJsonParse(raw, decodeWithSchema(containerRunHostRequestSchema))
  if (request === null) {
    log('the request file is not a run request')
    return 1
  }

  // The profile has to be in place before any module that opens a store loads,
  // so everything past this point is imported dynamically.
  await installReadOnlyProfile({
    userDataPath,
    version: values['app-version'] ?? 'container-run-host',
    packaged: values.packaged,
    log,
  })
  const [{ hostContainerRun }, { resolveContainerProvider }, { runThreadInContainer }] =
    await Promise.all([
      import('./run-host.ts'),
      import('../providers/container-provider.ts'),
      import('./thread-container.ts'),
    ])
  // A logout, a shutdown or a `kill` ends the run the way Stop does, so the
  // runner removes the staged sign-in and the container on its way out.
  const ended = new AbortController()
  const endings: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGHUP', 'SIGINT']
  for (const signal of endings) {
    process.once(signal, () => {
      ended.abort()
    })
  }
  await hostContainerRun(request, {
    signal: ended.signal,
    resolve: resolveContainerProvider,
    run: runThreadInContainer,
    socketPath: runHostSocketPath(userDataPath, request.runtimeId),
    hostFile: runHostFilePath(userDataPath, request.runtimeId),
    log,
  })
  return 0
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
