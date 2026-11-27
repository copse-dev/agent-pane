// Load the harness worker protocol document (`docs/plans/harness-worker-roadmap.md`,
// R2) for the generator and the build.
//
// The document is built from the zod schemas each end of a worker line checks
// its messages with (`src/main/services/worker-protocol/worker-protocol-document.ts`).
// Those modules use the main process's path aliases, so they are bundled the way
// the main process is before they are imported here.
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'
import { MAIN_EXTERNALS, MAIN_LOG_OVERRIDE } from '../main-externals.mts'

export type WorkerProtocolModule =
  typeof import('../../src/main/services/worker-protocol/worker-protocol-document.ts')

const ENTRY = 'src/main/services/worker-protocol/worker-protocol-document.ts'

function isWorkerProtocolModule(value: unknown): value is WorkerProtocolModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'workerProtocolDocument' in value &&
    typeof value.workerProtocolDocument === 'function'
  )
}

export async function loadWorkerProtocol(): Promise<WorkerProtocolModule> {
  // Inside the repo, so the bundle's externals resolve from its node_modules.
  const dir = mkdtempSync(resolve('node_modules', '.worker-protocol-'))
  const outfile = join(dir, 'worker-protocol.mjs')
  try {
    await esbuild.build({
      entryPoints: [resolve(ENTRY)],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      external: [...MAIN_EXTERNALS],
      logOverride: MAIN_LOG_OVERRIDE,
      alias: { '@shared': resolve('./src/shared') },
      define: { __COPSE_TEST_SCENARIOS__: 'false' },
      logLevel: 'error',
    })
    const loaded: unknown = await import(pathToFileURL(outfile).href)
    if (!isWorkerProtocolModule(loaded)) throw new Error(`${ENTRY} did not bundle as expected`)
    return loaded
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
