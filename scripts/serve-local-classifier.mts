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
 * Winnow on a machine without room for its 64K default. Nothing here is part of the app.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface ServerSpec {
  repository: string
  revision: string
  /** Commands run once in the checkout, in order. */
  setup: (paths: CachePaths) => string[][]
  serve: (paths: CachePaths) => string[]
  port: number
}

interface CachePaths {
  root: string
  checkout: string
  models: string
}

const SERVERS: Readonly<Record<string, ServerSpec>> = {
  kev: {
    repository: 'https://github.com/jaredpalmer/kev.git',
    revision: '2855ba2a55a80579176a459f78b95d03548cabb5',
    setup: () => [['uv', 'sync', '--extra', 'serve']],
    serve: () => [
      'uv',
      'run',
      '--extra',
      'serve',
      'python',
      '-m',
      'kev.serve',
      '--run',
      'jaredpalmer/kev-4b',
      '--port',
      '8009',
    ],
    port: 8009,
  },
  winnow: {
    repository: 'https://github.com/EldanRing/winnow-inference.git',
    revision: '77d14580c6732ca2f3745750c1dc1fd446d8bcee',
    setup: ({ models }) => [['python3', 'scripts/setup.py', '--text-only', '--model-dir', models]],
    serve: ({ models }) => ['python3', 'scripts/serve.py', '--text-only', '--model-dir', models],
    port: 8091,
  },
}

function cacheRoot(): string {
  const configured = process.env['COPSE_CLASSIFIER_CACHE']?.trim()
  if (configured) return configured
  const copseDir = process.env['COPSE_DIR']?.trim()
  // An empty COPSE_DIR means unset, as it does for the app.
  const copse = (copseDir === '' ? undefined : copseDir) ?? join(homedir(), '.copse')
  return join(copse, 'cache', 'classifiers')
}

/** Keep uv's packages and Hugging Face weights in the cache too, not on the home disk. */
function cacheEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    UV_CACHE_DIR: join(root, 'uv-cache'),
    // The cache may sit on another volume, where uv cannot hard-link.
    UV_LINK_MODE: 'copy',
    HF_HOME: join(root, 'huggingface'),
  }
}

function run(command: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const [program, ...args] = command
  if (!program) throw new Error('Empty command.')
  console.log(`[classifier:serve] ${command.join(' ')}`)
  const result = spawnSync(program, args, { cwd, env, stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`${command.join(' ')} exited with ${String(result.status ?? result.signal)}`)
  }
}

function prepare(name: string, spec: ServerSpec): CachePaths {
  const root = cacheRoot()
  const paths: CachePaths = {
    root,
    checkout: join(root, name, spec.revision),
    models: join(root, name, 'models'),
  }
  const env = cacheEnvironment(root)
  mkdirSync(join(root, name), { recursive: true })
  if (!existsSync(join(paths.checkout, '.git'))) {
    run(['git', 'clone', '--quiet', spec.repository, paths.checkout], root, env)
    run(['git', 'checkout', '--quiet', spec.revision], paths.checkout, env)
  }
  const marker = join(paths.checkout, '.copse-setup-complete')
  if (!existsSync(marker)) {
    mkdirSync(paths.models, { recursive: true })
    for (const command of spec.setup(paths)) run(command, paths.checkout, env)
    writeFileSync(marker, `${new Date().toISOString()}\n`)
  }
  return paths
}

function main(): number {
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const [name] = args
  const spec = name !== undefined && Object.hasOwn(SERVERS, name) ? SERVERS[name] : undefined
  if (name === undefined || spec === undefined) {
    console.error(
      `Usage: pnpm run classifier:serve -- <${Object.keys(SERVERS).join('|')}> [--setup-only] [server flags…]`,
    )
    return 2
  }
  const paths = prepare(name, spec)
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

process.exitCode = main()
