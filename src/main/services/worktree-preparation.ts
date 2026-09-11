import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { errorMessage } from '@shared/errors.ts'
import {
  DEPENDENCY_SENTINELS,
  DEV_STATE,
  dependencyFingerprint,
  type DependencyContextFingerprint,
} from '../../../scripts/lib/dev-sync.mts'
import {
  GORTEX_VERSION,
  NATIVE_PREPARATION_SCRIPT,
} from '../../../scripts/lib/native-artifacts.mts'
import { copseCacheDir } from './storage/copse-paths.ts'
import { emitShellOutput } from './exec/shell-output-context.ts'
import { envForRendererChildProcess } from './exec/child-process-env.ts'
import { sfwInstallArgs } from './security/socket-firewall.ts'
import {
  requirePreparationSandbox,
  runWorktreePreparationProcess,
} from '../project-sandbox/worktree-preparation.ts'

export type WorktreePreparationState =
  | 'ready'
  | 'absent'
  | 'stale'
  | 'corrupt'
  | 'unavailable-offline'

export interface WorktreePreparationComponent {
  ready: boolean
  detail: string
}

export interface WorktreePreparationReport {
  state: WorktreePreparationState
  expectedFingerprint: string
  components: {
    node: WorktreePreparationComponent
    pnpm: WorktreePreparationComponent
    dependencies: WorktreePreparationComponent
    electron: WorktreePreparationComponent
    chromedriver: WorktreePreparationComponent
    gortex: WorktreePreparationComponent
    remoteE2e: WorktreePreparationComponent
  }
  remediation: string
}

interface InspectOptions {
  env?: NodeJS.ProcessEnv
  offline?: boolean
  dependencyContext?: DependencyContextFingerprint
  probe?: ProcessProbe
}

interface PrepareOptions extends InspectOptions {
  signal: AbortSignal
}

type ProcessProbe = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => string | null | Promise<string | null>

const packageJsonSchema = z.object({
  name: z.string(),
  packageManager: z.string(),
  scripts: z.record(z.string(), z.string()),
})
const versionPackageSchema = z.object({ version: z.string() })
const remoteHostSchema = z.object({
  ip: z.string().min(1),
  user: z.string().min(1),
  createdAt: z.string().min(1),
})
const FINGERPRINT_RE = /^[a-f0-9]{64}$/

function sandboxProbe(root: string, signal?: AbortSignal): ProcessProbe {
  return async (command, args, env) => {
    try {
      return await runWorktreePreparationProcess(command, args, {
        root,
        env,
        mode: 'preflight',
        offline: true,
        ...(signal ? { signal } : {}),
      })
    } catch {
      return null
    }
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
}

function readVersionPackage(path: string): string | null {
  const text = readText(path)
  if (text === null) return null
  return safeJsonParse(text, decodeWithSchema(versionPackageSchema))?.version ?? null
}

function readProjectPackage(root: string): z.infer<typeof packageJsonSchema> {
  const text = readText(join(root, 'package.json'))
  const parsed = text ? safeJsonParse(text, decodeWithSchema(packageJsonSchema)) : null
  if (!parsed || parsed.name !== 'copse-panel') {
    throw new Error('prepare_worktree is only available in a Copse source checkout.')
  }
  if (parsed.scripts['prepare:native'] !== NATIVE_PREPARATION_SCRIPT) {
    throw new Error(
      `The repository's prepare:native entry point is missing or unexpected. Expected: ${NATIVE_PREPARATION_SCRIPT}`,
    )
  }
  return parsed
}

function pinnedPnpmVersion(packageManager: string): string {
  const match = /^pnpm@([^+\s]+)(?:\+.*)?$/.exec(packageManager)
  if (!match?.[1]) {
    throw new Error(`Unsupported packageManager value: ${packageManager}`)
  }
  return match[1]
}

async function resolveDependencyContext(
  env: NodeJS.ProcessEnv,
  probe: ProcessProbe,
  supplied: DependencyContextFingerprint | undefined,
): Promise<DependencyContextFingerprint | null> {
  if (supplied) return supplied
  const output = await probe(
    'node',
    ['-p', 'process.versions.node + "\\n" + process.versions.modules'],
    env,
  )
  if (!output) return null
  const [node, nodeModulesAbi] = output.split(/\r?\n/)
  if (!node || !nodeModulesAbi) return null
  return {
    node,
    nodeModulesAbi,
    platform: process.platform,
    arch: process.arch,
  }
}

function executableReady(path: string): boolean {
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

function existingRelativeTarget(root: string, relativeTarget: string | null): string | null {
  if (!relativeTarget || isAbsolute(relativeTarget)) return null
  const base = resolve(root)
  const target = resolve(base, relativeTarget)
  const rel = relative(base, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return existsSync(target) ? target : null
}

async function nativeArtifactComponents(
  root: string,
  probe: ProcessProbe,
  env: NodeJS.ProcessEnv,
): Promise<
  Pick<
    WorktreePreparationReport['components'],
    'dependencies' | 'electron' | 'chromedriver' | 'gortex'
  >
> {
  const missingDependencies = DEPENDENCY_SENTINELS.filter((path) => !existsSync(join(root, path)))
  const dependencies = {
    ready: missingDependencies.length === 0,
    detail:
      missingDependencies.length === 0
        ? 'installed tree present'
        : `missing ${missingDependencies.join(', ')}`,
  }

  const electronRoot = join(root, 'node_modules', 'electron')
  const electronVersion = readVersionPackage(join(electronRoot, 'package.json'))
  const distVersion = readText(join(electronRoot, 'dist', 'version'))?.replace(/^v/, '') ?? null
  const electronTarget = existingRelativeTarget(
    join(electronRoot, 'dist'),
    readText(join(electronRoot, 'path.txt')),
  )
  const electronReady =
    electronVersion !== null &&
    distVersion === electronVersion &&
    electronTarget !== null &&
    executableReady(electronTarget)
  const electron = {
    ready: electronReady,
    detail: electronReady
      ? `Electron ${electronVersion} runtime ready`
      : 'runtime missing, stale, or not executable',
  }

  const driverRoot = join(root, 'node_modules', 'electron-chromedriver')
  const driverVersion = readVersionPackage(join(driverRoot, 'package.json'))
  const driverBinary = join(
    driverRoot,
    'bin',
    process.platform === 'win32' ? 'chromedriver.exe' : 'chromedriver',
  )
  const driverOutput =
    driverVersion && executableReady(driverBinary)
      ? await probe(driverBinary, ['--version'], env)
      : null
  // The package is versioned with Electron (44.x), but the executable reports
  // Chromium (152.x). Compare its major to the actual Electron runtime, not
  // to the npm package's version or an arbitrary matching substring.
  const chromiumVersion =
    electronReady && electronTarget
      ? await probe(electronTarget, ['-p', 'process.versions.chrome'], {
          ...env,
          ELECTRON_RUN_AS_NODE: '1',
        })
      : null
  const chromiumMajor = chromiumVersion?.match(/^(\d+)\./)?.[1]
  const driverReady =
    driverVersion !== null &&
    driverVersion === electronVersion &&
    chromiumMajor !== undefined &&
    driverOutput?.match(/^ChromeDriver (\d+)\./)?.[1] === chromiumMajor

  const chromedriver = {
    ready: driverReady,
    detail: driverReady
      ? `ChromeDriver ${driverVersion} ready`
      : 'matching driver missing, corrupt, or not executable',
  }

  const gortexBinary = join(
    root,
    'vendor',
    'gortex',
    process.platform === 'win32' ? 'gortex.exe' : 'gortex',
  )
  const gortexOutput = executableReady(gortexBinary)
    ? await probe(gortexBinary, ['version'], env)
    : null
  const gortexReady =
    gortexOutput !== null && gortexOutput.includes(GORTEX_VERSION.replace(/^v/, ''))
  const gortex = {
    ready: gortexReady,
    detail: gortexReady
      ? `gortex ${GORTEX_VERSION} ready`
      : 'pinned gortex binary missing, stale, or corrupt',
  }

  return { dependencies, electron, chromedriver, gortex }
}

function fingerprintFileState(
  root: string,
): { kind: 'absent' | 'corrupt' } | { kind: 'present'; value: string } {
  const path = join(root, DEV_STATE.dependencies)
  const raw = readText(path)
  if (raw === null) return { kind: 'absent' }
  if (!FINGERPRINT_RE.test(raw)) return { kind: 'corrupt' }
  return { kind: 'present', value: raw }
}

function remoteE2eComponent(root: string, env: NodeJS.ProcessEnv): WorktreePreparationComponent {
  const registry = env['COPSE_CI_REGISTRY']?.trim()
  if (registry) return { ready: true, detail: `registry configured: ${registry}` }
  const hostPath = join(root, '.tmp', 'remote-e2e', 'host.json')
  const raw = readText(hostPath)
  if (raw === null) {
    return { ready: false, detail: 'no saved host or COPSE_CI_REGISTRY' }
  }
  const host = safeJsonParse(raw, decodeWithSchema(remoteHostSchema))
  return host
    ? { ready: true, detail: `saved host: ${host.user}@${host.ip}` }
    : { ready: false, detail: 'saved host record is corrupt' }
}

function requiredComponentsReady(report: WorktreePreparationReport): boolean {
  const { node, pnpm, dependencies, electron, chromedriver, gortex } = report.components
  return [node, pnpm, dependencies, electron, chromedriver, gortex].every(
    (component) => component.ready,
  )
}

function preparationCacheEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cacheRoot = copseCacheDir(env)
  return {
    ...env,
    COREPACK_HOME: join(cacheRoot, 'corepack'),
    npm_config_store_dir: join(cacheRoot, 'pnpm-store'),
    electron_config_cache: join(cacheRoot, 'electron-downloads'),
    COPSE_ELECTRON_DIST_CACHE: join(cacheRoot, 'electron-dist'),
    COPSE_GORTEX_CACHE: join(cacheRoot, 'gortex'),
  }
}

export function worktreePreparationShellEnvironment(
  root: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  try {
    readProjectPackage(root)
    return preparationCacheEnvironment(env)
  } catch {
    return env
  }
}

export function preparationEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...preparationCacheEnvironment(envForRendererChildProcess(env)),
    CI: 'true',
    SFW_SKIP_UPDATE_CHECK: '1',
    // Native build tooling hardcodes ~/.electron-gyp and similar directories.
    // Its home is a managed build cache, never the user's profile.
    HOME: join(copseCacheDir(env), 'native-build'),
    XDG_CACHE_HOME: join(copseCacheDir(env), 'native-build', '.cache'),
    npm_config_ignore_scripts: 'true',
    npm_config_cache: join(copseCacheDir(env), 'socket-firewall', 'npm-cache'),
  }
}

export async function inspectWorktreePreparation(
  root: string,
  options: InspectOptions = {},
): Promise<WorktreePreparationReport> {
  if (!options.probe) requirePreparationSandbox()
  const env = preparationEnvironment(options.env)
  const probe = options.probe ?? sandboxProbe(root)
  const pkg = readProjectPackage(root)
  const expectedPnpm = pinnedPnpmVersion(pkg.packageManager)
  const runtime = await resolveDependencyContext(env, probe, options.dependencyContext)
  const expectedFingerprint = dependencyFingerprint(
    root,
    runtime ?? {
      node: 'unavailable',
      nodeModulesAbi: 'unavailable',
      platform: process.platform,
      arch: process.arch,
    },
  )
  const pinnedNode = readText(join(root, '.nvmrc'))?.replace(/^v/, '') ?? 'unknown'
  const nodeReady = runtime !== null && runtime.node === pinnedNode
  const pnpmOutput = await probe('corepack', ['pnpm', '--version'], {
    ...env,
    COREPACK_ENABLE_NETWORK: '0',
  })
  const pnpmReady = pnpmOutput === expectedPnpm
  const native = await nativeArtifactComponents(root, probe, env)
  const fingerprint = fingerprintFileState(root)
  const fingerprintMatches =
    fingerprint.kind === 'present' && fingerprint.value === expectedFingerprint

  const components: WorktreePreparationReport['components'] = {
    node: {
      ready: nodeReady,
      detail: nodeReady
        ? `Node ${pinnedNode} ready`
        : `expected Node ${pinnedNode}, found ${runtime?.node ?? 'unavailable'}`,
    },
    pnpm: {
      ready: pnpmReady,
      detail: pnpmReady
        ? `pnpm ${expectedPnpm} ready in the Copse Corepack cache`
        : `expected pnpm ${expectedPnpm}, found ${pnpmOutput ?? 'unavailable'}`,
    },
    ...native,
    remoteE2e: remoteE2eComponent(root, env),
  }

  let state: WorktreePreparationState
  const allReady = [
    components.node,
    components.pnpm,
    components.dependencies,
    components.electron,
    components.chromedriver,
    components.gortex,
  ].every((component) => component.ready)
  if (fingerprintMatches && allReady) {
    state = 'ready'
  } else if (options.offline === true) {
    state = 'unavailable-offline'
  } else if (fingerprint.kind === 'corrupt') {
    state = 'corrupt'
  } else if (
    fingerprint.kind === 'present' &&
    (fingerprint.value !== expectedFingerprint || !components.node.ready || !components.pnpm.ready)
  ) {
    state = 'stale'
  } else if (fingerprintMatches) {
    state = 'corrupt'
  } else {
    state = 'absent'
  }

  const remediation =
    state === 'ready'
      ? 'No preparation needed.'
      : state === 'unavailable-offline'
        ? 'Reconnect to the network or restore the matching Copse cache, then run prepare_worktree again.'
        : 'Run prepare_worktree once; it installs lockfile-pinned inputs with lifecycle scripts disabled and prepares only the declared native artifacts.'

  return { state, expectedFingerprint, components, remediation }
}

async function runPreparationStep(
  command: string,
  args: readonly string[],
  root: string,
  env: NodeJS.ProcessEnv,
  options: PrepareOptions,
): Promise<void> {
  emitShellOutput(`[prepare-worktree] $ ${command} ${args.join(' ')}\n`)
  await runWorktreePreparationProcess(command, args, {
    root,
    env,
    mode: 'prepare',
    offline: options.offline === true,
    signal: options.signal,
    output: emitShellOutput,
  })
}

export async function prepareWorktree(
  root: string,
  options: PrepareOptions,
): Promise<WorktreePreparationReport> {
  requirePreparationSandbox()
  const before = await inspectWorktreePreparation(root, options)
  if (before.state === 'ready') return before

  const env = preparationEnvironment(options.env)
  // Temp files stay within the execution root, including downloads and native builds.
  await runPreparationStep(
    'node',
    [
      '-e',
      'require("node:fs").mkdirSync(process.argv[1], {recursive:true})',
      join(root, '.tmp', 'worktree-preparation'),
    ],
    root,
    env,
    options,
  )

  const firewallRoot = join(copseCacheDir(env), 'socket-firewall')
  const firewall = join(firewallRoot, 'bin', 'sfw')
  const probe = options.probe ?? sandboxProbe(root, options.signal)
  if (!(await probe(firewall, ['--version'], env))) {
    if (options.offline === true) {
      throw new Error(
        'Worktree preparation is unavailable offline because Socket Firewall is not installed in the managed cache.',
      )
    }
    await runPreparationStep(
      'npm',
      [...sfwInstallArgs(), '--prefix', firewallRoot],
      root,
      env,
      options,
    )
  }

  const installArgs = [
    'corepack',
    'pnpm',
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
    ...(options.offline === true ? ['--offline'] : []),
  ]
  try {
    await runPreparationStep(firewall, installArgs, root, env, options)
    await runPreparationStep('corepack', ['pnpm', 'run', 'prepare:native'], root, env, options)
  } catch (error) {
    if (options.offline === true) {
      throw new Error(`Matching cached inputs are unavailable offline. ${errorMessage(error)}`, {
        cause: error,
      })
    }
    throw error
  }

  const runtime = await resolveDependencyContext(env, probe, options.dependencyContext)
  if (!runtime)
    throw new Error('Prepared dependencies, but the pinned Node runtime is unavailable.')
  const fingerprint = dependencyFingerprint(root, runtime)
  const validation = await inspectWorktreePreparation(root, {
    ...options,
    dependencyContext: runtime,
  })
  if (!requiredComponentsReady(validation)) {
    throw new Error(
      `Native preparation finished but validation failed:\n${formatWorktreePreparationReport(validation)}`,
    )
  }
  // Record readiness inside the same boundary: a checkout-controlled symlink
  // must not redirect a host-side fingerprint write outside the execution root.
  await runPreparationStep(
    'node',
    [
      '-e',
      'const fs=require("node:fs"),p=require("node:path");fs.mkdirSync(p.dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],process.argv[2]+"\\n")',
      join(root, DEV_STATE.dependencies),
      fingerprint,
    ],
    root,
    env,
    options,
  )

  const complete = await inspectWorktreePreparation(root, {
    ...options,
    dependencyContext: runtime,
  })
  if (complete.state !== 'ready') {
    throw new Error(
      `Preparation did not produce a ready worktree:\n${formatWorktreePreparationReport(complete)}`,
    )
  }
  return complete
}

export function formatWorktreePreparationReport(report: WorktreePreparationReport): string {
  const labels: Array<[string, WorktreePreparationComponent]> = [
    ['Node', report.components.node],
    ['pnpm', report.components.pnpm],
    ['Dependencies', report.components.dependencies],
    ['Electron', report.components.electron],
    ['ChromeDriver', report.components.chromedriver],
    ['gortex', report.components.gortex],
    ['Remote E2E', report.components.remoteE2e],
  ]
  return [
    `Worktree preparation: ${report.state}`,
    ...labels.map(
      ([label, component]) =>
        `- ${component.ready ? 'ready' : 'not ready'} — ${label}: ${component.detail}`,
    ),
    `Remediation: ${report.remediation}`,
  ].join('\n')
}
