import { createHash, type Hash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const FINGERPRINT_RE = /^[a-f0-9]{64}$/
const HASH_SCHEMA = 'copse-dev-sync-v1'

export const DEV_STATE = {
  dependencies: '.tmp/dev-dependencies.fingerprint',
  build: '.tmp/dev-build.fingerprint',
  buildOutputs: '.tmp/dev-build-outputs.fingerprint',
  distMarker: 'dist/.copse-build-fingerprint',
} as const

export const DEPENDENCY_SENTINELS = [
  'node_modules/.modules.yaml',
  'node_modules/esbuild/package.json',
] as const

/**
 * Host-native setup code is part of dependency identity: changing one of these
 * files must invalidate a previously prepared worktree even when the lockfile
 * is unchanged.
 */
export const NATIVE_PREPARATION_INPUTS = [
  'scripts/prepare-native-artifacts.mts',
  'scripts/lib/native-artifacts.mts',
  'scripts/check-node-version.cjs',
  'scripts/patch-dev-name.mts',
  'scripts/postinstall-native.mts',
  'scripts/fetch-gortex.mts',
  'scripts/gortex-checksums.json',
] as const

export const BUILD_SENTINELS = [
  'dist/main/index.js',
  'dist/preload/index.js',
  'dist/renderer/app.js',
  'dist/renderer/index.html',
] as const

function updateField(hash: Hash, label: string, value: string): void {
  hash.update(`${String(label.length)}:${label}${String(value.length)}:${value}`)
}

function hashPath(hash: Hash, root: string, path: string): void {
  const absolute = resolve(root, path)
  const display = relative(root, absolute).replaceAll('\\', '/') || '.'
  if (!existsSync(absolute)) {
    updateField(hash, 'missing', display)
    return
  }

  const stat = lstatSync(absolute)
  const mode = String(stat.mode & 0o777)
  if (stat.isSymbolicLink()) {
    updateField(hash, 'symlink', `${display}\0${mode}\0${readlinkSync(absolute)}`)
    return
  }
  if (stat.isDirectory()) {
    updateField(hash, 'directory', `${display}\0${mode}`)
    for (const child of readdirSync(absolute).sort()) {
      if (child === 'node_modules' || child === 'dist' || child === '.tmp') continue
      hashPath(hash, root, join(path, child))
    }
    return
  }
  if (stat.isFile()) {
    updateField(hash, 'file', `${display}\0${mode}`)
    updateField(hash, 'file-size', String(stat.size))
    hash.update(readFileSync(absolute))
    return
  }
  updateField(hash, 'other', `${display}\0${mode}`)
}

/** Hash paths by name, type, mode, and bytes; additions and deletions are inputs. */
export function fingerprintPaths(root: string, paths: readonly string[]): string {
  const hash = createHash('sha256')
  updateField(hash, 'schema', HASH_SCHEMA)
  for (const path of [...new Set(paths)].sort()) hashPath(hash, root, path)
  return hash.digest('hex')
}

function packageManifests(root: string): string[] {
  const manifests = ['package.json']
  const packages = resolve(root, 'packages')
  if (!existsSync(packages)) return manifests

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile() && entry.name === 'package.json') {
        manifests.push(relative(root, absolute))
      }
    }
  }
  visit(packages)
  return manifests
}

export interface DependencyContextFingerprint {
  node: string
  nodeModulesAbi: string
  platform: NodeJS.Platform
  arch: string
}

export function dependencyFingerprint(
  root = process.cwd(),
  context: DependencyContextFingerprint = {
    node: process.versions.node,
    nodeModulesAbi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
  },
): string {
  const inputs = fingerprintPaths(root, [
    '.npmrc',
    '.nvmrc',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'patches',
    ...NATIVE_PREPARATION_INPUTS,
    ...packageManifests(root),
  ])
  const hash = createHash('sha256')
  updateField(hash, 'schema', HASH_SCHEMA)
  updateField(hash, 'inputs', inputs)
  updateField(hash, 'node', context.node)
  updateField(hash, 'node-modules-abi', context.nodeModulesAbi)
  updateField(hash, 'platform', context.platform)
  updateField(hash, 'arch', context.arch)
  return hash.digest('hex')
}

export interface BuildContextFingerprint {
  gitHead: string
  gitDirty: boolean
  node: string
  platform: NodeJS.Platform
  arch: string
  environment: Readonly<Record<string, string>>
}

export function buildFingerprint(
  root: string,
  dependencies: string,
  context: BuildContextFingerprint,
): string {
  const inputs = fingerprintPaths(root, [
    'assets',
    'package.json',
    'packages',
    'pnpm-lock.yaml',
    'scripts',
    'src',
    'tsconfig.json',
    'tsconfig.node.json',
    'tsconfig.web.json',
    'vendor/bundled-cursor-skills',
    'vendor/gortex',
  ])
  const hash = createHash('sha256')
  updateField(hash, 'schema', HASH_SCHEMA)
  updateField(hash, 'dependencies', dependencies)
  updateField(hash, 'inputs', inputs)
  updateField(hash, 'git-head', context.gitHead)
  updateField(hash, 'git-dirty', context.gitDirty ? 'true' : 'false')
  updateField(hash, 'node', context.node)
  updateField(hash, 'platform', context.platform)
  updateField(hash, 'arch', context.arch)
  for (const [name, value] of Object.entries(context.environment).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    updateField(hash, `environment:${name}`, value)
  }
  return hash.digest('hex')
}

export function readFingerprint(root: string, path: string): string | null {
  try {
    const value = readFileSync(resolve(root, path), 'utf8').trim()
    return FINGERPRINT_RE.test(value) ? value : null
  } catch {
    return null
  }
}

export function writeFingerprint(root: string, path: string, fingerprint: string): void {
  if (!FINGERPRINT_RE.test(fingerprint)) throw new Error(`Invalid fingerprint for ${path}`)
  const absolute = resolve(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  const temporary = `${absolute}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${fingerprint}\n`)
  renameSync(temporary, absolute)
}

function sentinelsExist(root: string, paths: readonly string[]): boolean {
  return paths.every((path) => existsSync(resolve(root, path)))
}

export function dependenciesAreCurrent(root: string, expected: string): boolean {
  return (
    readFingerprint(root, DEV_STATE.dependencies) === expected &&
    sentinelsExist(root, DEPENDENCY_SENTINELS)
  )
}

export function buildOutputsFingerprint(root: string): string {
  const dist = resolve(root, 'dist')
  if (!existsSync(dist)) return fingerprintPaths(root, ['dist'])
  return fingerprintPaths(
    root,
    readdirSync(dist)
      .filter((entry) => entry !== '.copse-build-fingerprint')
      .map((entry) => join('dist', entry)),
  )
}

export function buildIsCurrent(root: string, expected: string): boolean {
  if (!sentinelsExist(root, BUILD_SENTINELS)) return false
  if (readFingerprint(root, DEV_STATE.build) !== expected) return false
  if (readFingerprint(root, DEV_STATE.distMarker) !== expected) return false
  const recordedOutputs = readFingerprint(root, DEV_STATE.buildOutputs)
  return recordedOutputs !== null && recordedOutputs === buildOutputsFingerprint(root)
}
