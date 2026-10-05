/**
 * Set up and start a self-hosted systemone classifier from a persistent cache,
 * at a pinned revision, so `pnpm run eval:classifier` has a server to call.
 *
 *   pnpm run classifier:serve -- <kev|winnow> [--setup-only] [server flags…]
 *
 * Everything the server needs lives under one cache root: the checkout, its
 * virtual environment or native build, the uv package cache and the model
 * weights. The root is `COPSE_CLASSIFIER_CACHE`, or `<COPSE_DIR or ~/.copse>/cache/classifiers`.
 * Point it at a large external volume when the internal disk is short.
 *
 * The first run clones, installs and downloads the weights (Kev about 8 GB, Winnow
 * about 12.5 GB text-only); later runs reuse the cache and download nothing. The
 * servers bind 127.0.0.1 on the port their `benchmarks/classifiers/*.json`
 * profile names. Flags after the name go to the server, such as `--context 16384` for
 * Winnow on a machine without room for its 64K default. The app's Settings → Classifiers
 * installer uses the same catalog and cache (`src/main/services/classifiers/local-server.mts`).
 */
import { isDirectExecution } from './lib/direct-execution.mts'
import { spawn } from 'node:child_process'
import {
  LOCAL_CLASSIFIER_SERVERS,
  cacheEnvironment,
  localClassifierEntry,
  prepareClassifierCache,
} from '../src/main/services/classifiers/local-server.mts'

export { prepareClassifierCache }
export type { ServerSpec } from '../src/main/services/classifiers/local-server.mts'

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const [name] = args
  const spec = name === undefined ? undefined : localClassifierEntry(name)
  if (name === undefined || spec === undefined) {
    console.error(
      `Usage: pnpm run classifier:serve -- <${Object.keys(LOCAL_CLASSIFIER_SERVERS).join('|')}> [--setup-only] [server flags…]`,
    )
    return 2
  }
  const paths = await prepareClassifierCache(name, spec)
  console.log(`[classifier:serve] ${name} ready in ${paths.checkout}`)
  if (args.includes('--setup-only')) return 0
  const passthrough = args.slice(1).filter((arg) => arg !== '--setup-only')
  const [program, ...serveArgs] = [...spec.serve(paths), ...passthrough]
  if (!program) return 2
  console.log(`[classifier:serve] serving ${name} on http://127.0.0.1:${String(spec.port)}/v1`)
  const child = spawn(program, serveArgs, {
    cwd: paths.checkout,
    env: cacheEnvironment(paths.root),
    stdio: 'inherit',
  })
  const stop = (): void => {
    child.kill('SIGINT')
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  child.once('exit', (code) => {
    process.exitCode = code ?? 1
  })
  return 0
}

if (isDirectExecution(import.meta.url, 'serve-local-classifier')) {
  main().then(
    (code) => {
      if (code !== 0) process.exitCode = code
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    },
  )
}
