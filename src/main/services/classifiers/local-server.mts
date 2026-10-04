/**
 * Catalog and persistent cache for self-hosted systemone classifier servers.
 *
 * Shared by `pnpm run classifier:serve` and the app's Settings → Classifiers
 * installer, so both set a server up the same way: a clone at a pinned revision,
 * its virtual environment or native build, the uv package cache, the Hugging
 * Face cache and the model weights all live under one cache root. This module
 * imports no Electron and no path aliases so a plain `node` script can load it.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'

export interface ServerSpec {
  repository: string
  revision: string
  /** Commands run once in the checkout, in order. */
  setup: (paths: CachePaths) => string[][]
  serve: (paths: CachePaths) => string[]
  port: number
}

/** A catalog entry: how to build and start one server, and how to describe it to a person. */
export interface CatalogEntry extends ServerSpec {
  /** The `CLASSIFIER_PRESETS` id whose profile talks to this server. */
  presetId: string
  label: string
  /** Rough download for the confirmation prompt, in decimal gigabytes. */
  downloadGb: number
  /** Programs the setup runs; each must answer `--version`. */
  prerequisites: readonly string[]
}

export interface CachePaths {
  root: string
  checkout: string
  models: string
}

export const LOCAL_CLASSIFIER_SERVERS: Readonly<Record<string, CatalogEntry>> = {
  kev: {
    presetId: 'kev',
    label: 'Kev',
    downloadGb: 8,
    prerequisites: ['git', 'uv'],
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
    presetId: 'winnow',
    label: 'Winnow-12B',
    downloadGb: 12.5,
    prerequisites: ['git', 'python3'],
    repository: 'https://github.com/EldanRing/winnow-inference.git',
    revision: '77d14580c6732ca2f3745750c1dc1fd446d8bcee',
    setup: ({ models }) => [['python3', 'scripts/setup.py', '--text-only', '--model-dir', models]],
    serve: ({ models }) => ['python3', 'scripts/serve.py', '--text-only', '--model-dir', models],
    port: 8091,
  },
}

export function localClassifierEntry(name: string): CatalogEntry | undefined {
  return Object.hasOwn(LOCAL_CLASSIFIER_SERVERS, name) ? LOCAL_CLASSIFIER_SERVERS[name] : undefined
}

export function cacheRoot(): string {
  const configured = process.env['COPSE_CLASSIFIER_CACHE']?.trim()
  if (configured) return configured
  const copseDir = process.env['COPSE_DIR']?.trim()
  // An empty COPSE_DIR means unset, as it does for the app.
  const copse = (copseDir === '' ? undefined : copseDir) ?? join(homedir(), '.copse')
  return join(copse, 'cache', 'classifiers')
}

export function cachePaths(name: string, spec: ServerSpec): CachePaths {
  const root = cacheRoot()
  return {
    root,
    checkout: join(root, name, spec.revision),
    models: join(root, name, 'models'),
  }
}

/** Keep uv's packages and Hugging Face weights in the cache too, not on the home disk. */
export function cacheEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    UV_CACHE_DIR: join(root, 'uv-cache'),
    // The cache may sit on another volume, where uv cannot hard-link.
    UV_LINK_MODE: 'copy',
    HF_HOME: join(root, 'huggingface'),
  }
}

export interface RunOptions {
  /** Receives each output line. Without it the command inherits this process's stdio. */
  onLine?: (line: string) => void
  signal?: AbortSignal
}

/** Run one command to completion. Rejects on a non-zero exit or an abort. */
export function runCommand(
  command: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: RunOptions = {},
): Promise<string> {
  const [program, ...args] = command
  if (!program) return Promise.reject(new Error('Empty command.'))
  const { onLine, signal } = options
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Cancelled.'))
      return
    }
    const captured: string[] = []
    const child = spawn(program, args, {
      cwd,
      env,
      stdio: onLine ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
    let pending = ''
    const feed = (chunk: Buffer): void => {
      pending += chunk.toString('utf8')
      const lines = pending.split(/\r\n|\r|\n/u)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        captured.push(line)
        if (line.trim()) onLine?.(line)
      }
    }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    const abort = (): void => {
      child.kill('SIGTERM')
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.once('error', (error) => {
      signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('close', (code, killedBy) => {
      signal?.removeEventListener('abort', abort)
      if (pending.trim()) {
        captured.push(pending)
        onLine?.(pending)
      }
      if (signal?.aborted) reject(new Error('Cancelled.'))
      else if (code !== 0) {
        reject(new Error(`${command.join(' ')} exited with ${String(code ?? killedBy)}`))
      } else resolve(captured.join('\n').trim())
    })
  })
}

function setupMarker(spec: ServerSpec): string {
  return `${JSON.stringify({ version: 1, repository: spec.repository, revision: spec.revision })}\n`
}

async function readMarker(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** True once setup finished at exactly the pinned revision. Reads only a marker file. */
export async function isClassifierInstalled(name: string, spec: ServerSpec): Promise<boolean> {
  const { checkout } = cachePaths(name, spec)
  return (await readMarker(join(checkout, '.copse-setup-complete'))) === setupMarker(spec)
}

/** Whether `program --version` runs. Used to name a missing tool before a long download starts. */
export function programAvailable(program: string): Promise<boolean> {
  return runCommand([program, '--version'], process.cwd(), process.env, {
    onLine: () => undefined,
  }).then(
    () => true,
    () => false,
  )
}

export async function prepareClassifierCache(
  name: string,
  spec: ServerSpec,
  options: RunOptions = {},
): Promise<CachePaths> {
  const paths = cachePaths(name, spec)
  const env = cacheEnvironment(paths.root)
  const run = async (command: readonly string[], cwd: string): Promise<string> => {
    options.onLine?.(`$ ${command.join(' ')}`)
    if (!options.onLine) console.log(`[classifier:serve] ${command.join(' ')}`)
    return runCommand(command, cwd, env, options)
  }
  // Output is captured for these, so a quiet inherit-stdio run still returns text.
  const output = (command: readonly string[], cwd: string): Promise<string> =>
    runCommand(command, cwd, env, { onLine: () => undefined, ...withSignal(options) })
  mkdirSync(join(paths.root, name), { recursive: true })
  if (!existsSync(join(paths.checkout, '.git'))) {
    await run(['git', 'clone', '--quiet', spec.repository, paths.checkout], paths.root)
  }
  const origin = await output(['git', 'remote', 'get-url', 'origin'], paths.checkout)
  if (origin !== spec.repository) {
    throw new Error(
      `${paths.checkout} has unexpected origin ${origin}; expected ${spec.repository}`,
    )
  }
  const dirty = await output(['git', 'status', '--short', '--untracked-files=no'], paths.checkout)
  if (dirty) {
    throw new Error(`${paths.checkout} has tracked modifications; refusing to run unpinned code`)
  }
  const hasRevision = await output(
    ['git', 'cat-file', '-e', `${spec.revision}^{commit}`],
    paths.checkout,
  ).then(
    () => true,
    () => false,
  )
  if (!hasRevision) {
    await run(['git', 'fetch', '--quiet', 'origin', spec.revision], paths.checkout)
  }
  // A clone interrupted after creating `.git`, or a cache checkout moved by hand,
  // must never turn the claimed pinned revision into the repository's default head.
  await run(['git', 'checkout', '--quiet', '--detach', spec.revision], paths.checkout)
  const head = await output(['git', 'rev-parse', 'HEAD'], paths.checkout)
  if (head !== spec.revision) {
    throw new Error(`${paths.checkout} is at ${head}; expected ${spec.revision}`)
  }
  const marker = join(paths.checkout, '.copse-setup-complete')
  if ((await readMarker(marker)) !== setupMarker(spec)) {
    mkdirSync(paths.models, { recursive: true })
    for (const command of spec.setup(paths)) await run(command, paths.checkout)
    await writeFile(marker, setupMarker(spec))
  }
  return paths
}

function withSignal(options: RunOptions): RunOptions {
  return options.signal ? { signal: options.signal } : {}
}

/** Whether something accepts TCP connections on the loopback port. Sends no data. */
export function portListening(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (listening: boolean): void => {
      socket.destroy()
      resolve(listening)
    }
    socket.setTimeout(timeoutMs, () => {
      finish(false)
    })
    socket.once('connect', () => {
      finish(true)
    })
    socket.once('error', () => {
      finish(false)
    })
  })
}
