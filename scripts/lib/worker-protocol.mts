// Load the harness worker protocol document (`docs/plans/harness-worker-roadmap.md`,
// R2) for the generator and the build.
//
// The document is built from the zod schemas each end of a worker line checks
// its messages with (`src/main/services/worker-protocol/worker-protocol-document.ts`).
// Those modules use the main process's path aliases, so they are bundled the way
// the main process is before they are imported here.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'
import { MAIN_EXTERNALS, MAIN_LOG_OVERRIDE } from '../main-externals.mts'

export type WorkerProtocolModule =
  typeof import('../../src/main/services/worker-protocol/worker-protocol-document.ts')

const ROOT = resolve(import.meta.dirname, '..', '..')
const ENTRY = 'src/main/services/worker-protocol/worker-protocol-document.ts'

export async function loadWorkerProtocol(): Promise<WorkerProtocolModule> {
  // Inside the repo (ignored `.tmp/`), so the bundle's externals resolve from
  // its node_modules.
  mkdirSync(join(ROOT, '.tmp'), { recursive: true })
  const dir = mkdtempSync(join(ROOT, '.tmp', 'worker-protocol-'))
  const outfile = join(dir, 'worker-protocol.mjs')
  try {
    await esbuild.build({
      entryPoints: [join(ROOT, ENTRY)],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      external: [...MAIN_EXTERNALS],
      logOverride: MAIN_LOG_OVERRIDE,
      alias: { '@shared': join(ROOT, 'src', 'shared') },
      define: { __COPSE_TEST_SCENARIOS__: 'false' },
      logLevel: 'error',
    })
    // The bundle of the module the type names, built just above.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dynamic import of our own bundle
    return (await import(pathToFileURL(outfile).href)) as WorkerProtocolModule
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
