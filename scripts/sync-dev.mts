import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import {
  BUILD_SENTINELS,
  DEV_STATE,
  buildFingerprint,
  buildIsCurrent,
  buildOutputsFingerprint,
  dependenciesAreCurrent,
  dependencyFingerprint,
  writeFingerprint,
} from './lib/dev-sync.mts'

type Mode = 'deps' | 'build'

function git(root: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function run(
  root: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.signal ?? String(result.status)})`,
    )
  }
}

function clearInstalledTree(root: string): void {
  const installed = resolve(root, 'node_modules')
  if (!existsSync(installed)) return
  const temporaryRoot = resolve(root, '.tmp')
  mkdirSync(temporaryRoot, { recursive: true })
  const trash = resolve(temporaryRoot, `node_modules-old.${String(process.pid)}`)
  rmSync(trash, { recursive: true, force: true })
  try {
    renameSync(installed, trash)
    try {
      rmSync(trash, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
    } catch {
      console.warn(`==> Some of ${trash} survived deletion; a later run will sweep it.`)
    }
  } catch {
    console.warn('==> Could not move node_modules aside; pnpm will reconcile it in place.')
  }
}

function sweepOldInstalledTrees(root: string): void {
  const temporaryRoot = resolve(root, '.tmp')
  if (!existsSync(temporaryRoot)) return
  for (const entry of readdirSync(temporaryRoot)) {
    if (!entry.startsWith('node_modules-old.')) continue
    rmSync(resolve(temporaryRoot, entry), { recursive: true, force: true })
  }
}

function installDependencies(root: string, fingerprint: string): void {
  console.log("==> Dependency inputs changed — running 'pnpm install --frozen-lockfile'…")
  sweepOldInstalledTrees(root)
  clearInstalledTree(root)
  run(root, 'corepack', ['enable'])
  run(root, 'pnpm', ['install', '--frozen-lockfile'], {
    ...process.env,
    npm_config_ignore_scripts: 'false',
  })
  writeFingerprint(root, DEV_STATE.dependencies, fingerprint)
}

function contextFingerprint(root: string): Parameters<typeof buildFingerprint>[2] {
  const status = git(root, ['status', '--porcelain', '--untracked-files=normal'])
  return {
    gitHead: git(root, ['rev-parse', 'HEAD']) ?? 'unknown',
    gitDirty: status === null || status.length > 0,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    environment: {
      COPSE_BUILD_COMMIT: process.env['COPSE_BUILD_COMMIT'] ?? '',
      COPSE_RELEASE: process.env['COPSE_RELEASE'] ?? '',
      MONACO_BASE_URL: process.env['MONACO_BASE_URL'] ?? '',
    },
  }
}

function buildApplication(root: string, fingerprint: string): void {
  console.log('==> Build inputs changed — clearing dist/ and rebuilding…')
  rmSync(resolve(root, 'dist'), { recursive: true, force: true })
  run(root, 'pnpm', ['run', 'build'])
  for (const path of BUILD_SENTINELS) {
    if (!existsSync(resolve(root, path))) throw new Error(`Build did not produce ${path}`)
  }
  writeFingerprint(root, DEV_STATE.distMarker, fingerprint)
  writeFingerprint(root, DEV_STATE.buildOutputs, buildOutputsFingerprint(root))
  writeFingerprint(root, DEV_STATE.build, fingerprint)
}

export function syncDevelopmentTree(mode: Mode, root = process.cwd()): void {
  const dependencies = dependencyFingerprint(root)
  if (dependenciesAreCurrent(root, dependencies)) {
    console.log(`==> Dependencies current (${dependencies.slice(0, 12)})`)
  } else {
    installDependencies(root, dependencies)
  }
  if (mode === 'deps') return

  const build = buildFingerprint(root, dependencies, contextFingerprint(root))
  if (buildIsCurrent(root, build)) {
    console.log(`==> dist/ current (${build.slice(0, 12)})`)
  } else {
    buildApplication(root, build)
  }
}

function main(): void {
  const requested = process.argv[2] ?? 'build'
  if (requested !== 'deps' && requested !== 'build') {
    throw new Error(`Usage: node scripts/sync-dev.mts [deps|build]`)
  }
  syncDevelopmentTree(requested)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
