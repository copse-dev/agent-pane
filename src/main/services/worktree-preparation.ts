import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { satisfies, valid, validRange } from 'semver'
import { errorMessage } from '@shared/errors.ts'
import { copseCacheDir } from './storage/copse-paths.ts'
import { nodeWorkerExecutable } from './node-worker-runtime.ts'
import { emitShellOutput } from './exec/shell-output-context.ts'
import { envForRendererChildProcess } from './exec/child-process-env.ts'
import { sfwInstallArgs } from './security/socket-firewall.ts'
import {
  requirePreparationSandbox,
  runWorktreePreparationProcess,
} from '../project-sandbox/worktree-preparation.ts'
import {
  PREPARATION_STAMP,
  containedPreparationPath,
  formatPreparationPlan,
  packageInstallCommand,
  packageManagerCommand,
  readWorktreePreparationPlan,
  type PreparationCommand,
  type WorktreePreparationPlan,
} from './worktree-preparation-plan.ts'

export type WorktreePreparationState =
  | 'ready'
  | 'absent'
  | 'stale'
  | 'corrupt'
  | 'unavailable-offline'
  | 'needs-configuration'
export interface WorktreePreparationComponent {
  name: string
  ready: boolean
  detail: string
}
export interface WorktreePreparationReport {
  state: WorktreePreparationState
  planFingerprint: string
  expectedFingerprint: string
  components: WorktreePreparationComponent[]
  plan: string
  remediation: string
}
interface InspectOptions {
  env?: NodeJS.ProcessEnv
  offline?: boolean
  /** Process boundary injection: production always uses the read-only OS sandbox. */
  probe?: ProcessProbe
}
interface PrepareOptions extends InspectOptions {
  planFingerprint: string
  signal: AbortSignal
}
type ProcessProbe = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => string | null | Promise<string | null>
const cargoExecutableEnv = 'CARGO'
const rustcExecutableEnv = 'RUSTC'

function sandboxProbe(
  root: string,
  signal?: AbortSignal,
  onFailure?: (message: string) => void,
  goBookkeeping = false,
  cargoAdapter = false,
): ProcessProbe {
  return async (command, args, env) => {
    try {
      return await runWorktreePreparationProcess(command, args, {
        root,
        env,
        mode: 'preflight',
        offline: true,
        goBookkeeping,
        cargoAdapter,
        ...(signal ? { signal } : {}),
      })
    } catch (error) {
      signal?.throwIfAborted()
      onFailure?.(errorMessage(error).slice(0, 1500))
      return null
    }
  }
}

function preparationCacheEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const root = copseCacheDir(env)
  return {
    ...env,
    COREPACK_HOME: join(root, 'corepack'),
    COREPACK_ENABLE_AUTO_PIN: '0',
    npm_config_store_dir: join(root, 'pnpm-store'),
    npm_config_cache: join(root, 'npm'),
    YARN_CACHE_FOLDER: join(root, 'yarn'),
    YARN_GLOBAL_FOLDER: join(root, 'yarn', 'global'),
    BUN_INSTALL_CACHE_DIR: join(root, 'bun'),
    UV_CACHE_DIR: join(root, 'uv'),
    GOMODCACHE: join(root, 'go', 'mod'),
    GOCACHE: join(root, 'go', 'build'),
    GOPATH: join(root, 'go', 'path'),
    electron_config_cache: join(root, 'electron-downloads'),
    COPSE_ELECTRON_DIST_CACHE: join(root, 'electron-dist'),
    COPSE_GORTEX_CACHE: join(root, 'gortex'),
  }
}

function boundedFile(path: string): string | null {
  try {
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 64 * 1024) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function containedToolchainFile(toolchain: string, path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null
    const canonical = realpathSync(path)
    const rel = relative(toolchain, canonical)
    return rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
      ? null
      : canonical
  } catch {
    return null
  }
}

export function selectInstalledRustupToolchainName(
  requested: string,
  defaultName: string | undefined,
  defaultHost: string | undefined,
  installedNames: readonly string[],
): string | null {
  if (installedNames.includes(requested)) return requested
  if (
    defaultName &&
    (defaultName === requested || defaultName.startsWith(`${requested}-`)) &&
    installedNames.includes(defaultName)
  )
    return defaultName
  const hostQualified = defaultHost ? `${requested}-${defaultHost}` : null
  if (hostQualified && installedNames.includes(hostQualified)) return hostQualified
  const matches = installedNames.filter((name) => name.startsWith(`${requested}-`))
  return matches.length === 1 ? (matches[0] ?? null) : null
}

/** Select an already-installed Cargo toolchain without invoking rustup or allowing downloads. */
export function resolveInstalledRustToolchainBin(
  root: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (lstatSync(join(root, 'rust-toolchain.toml'), { throwIfNoEntry: false })) return null
  const selectedToolchainFile = lstatSync(join(root, 'rust-toolchain'), {
    throwIfNoEntry: false,
  })
    ? 'rust-toolchain'
    : undefined
  const toolchainText = selectedToolchainFile
    ? boundedFile(join(root, selectedToolchainFile))
    : null
  if (selectedToolchainFile && toolchainText === null) return null
  const projectRequest = toolchainText?.trim()
  if (selectedToolchainFile && !projectRequest) return null
  if (projectRequest && !/^[A-Za-z0-9._-]+$/.test(projectRequest)) return null
  const resolveRustupToolchain = (requestedProject: string | undefined): string | null => {
    try {
      const rustup = join(homedir(), '.rustup')
      const settings = boundedFile(join(rustup, 'settings.toml'))
      const defaultName = settings?.match(/^default_toolchain\s*=\s*["']([^"']+)["']/m)?.[1]
      const defaultHost = settings?.match(/^default_host_triple\s*=\s*["']([^"']+)["']/m)?.[1]
      const requested = requestedProject ?? defaultName
      if (!requested || !/^[A-Za-z0-9._-]+$/.test(requested)) return null
      const toolchains = join(rustup, 'toolchains')
      const installedName = selectInstalledRustupToolchainName(
        requested,
        defaultName,
        defaultHost,
        readdirSync(toolchains),
      )
      if (!installedName) return null
      const toolchain = realpathSync(join(toolchains, installedName))
      const rel = relative(toolchains, toolchain)
      if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        return null
      const bin = join(toolchain, 'bin')
      return containedToolchainFile(toolchain, join(bin, 'cargo')) &&
        containedToolchainFile(toolchain, join(bin, 'rustc'))
        ? bin
        : null
    } catch {
      return null
    }
  }
  // A project pin is authoritative. Resolve it from the fixed installed
  // toolchain store before considering PATH, and never fall back to system Cargo.
  if (projectRequest) return resolveRustupToolchain(projectRequest)
  const pathCandidates = (env['PATH'] ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, 'cargo'))
  for (const candidate of pathCandidates) {
    try {
      const cargo = realpathSync(candidate)
      if (!statSync(cargo).isFile()) continue
      if (basenameWithoutExtension(cargo) !== 'rustup') {
        const trustedRoot = ['/usr', '/usr/local', '/opt/homebrew'].find((prefix) => {
          const rel = relative(prefix, cargo)
          return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
        })
        if (!trustedRoot) continue
        const bin = dirname(cargo)
        if (containedToolchainFile(dirname(bin), join(bin, 'rustc'))) return bin
        continue
      }
      return resolveRustupToolchain(undefined)
    } catch {
      /* Try another PATH entry. */
    }
  }
  return null
}

function basenameWithoutExtension(path: string): string {
  const name = path.slice(path.lastIndexOf(sep) + 1)
  return process.platform === 'win32' ? name.replace(/\.exe$/i, '') : name
}

export function worktreePreparationShellEnvironment(
  root: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!existsSync(root)) return env
  try {
    const plan = readWorktreePreparationPlan(root)
    if (plan.problems.length !== 0) return env
    const result = preparationCacheEnvironment(env)
    return plan.ecosystem === 'cargo'
      ? { ...result, CARGO_HOME: join(copseCacheDir(env), 'cargo') }
      : result
  } catch {
    return env
  }
}

export function preparationEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const caches = preparationCacheEnvironment(envForRendererChildProcess(env))
  return {
    ...caches,
    CI: 'true',
    NODE_ENV: 'development',
    SFW_SKIP_UPDATE_CHECK: '1',
    HOME: join(copseCacheDir(env), 'native-build'),
    XDG_CACHE_HOME: join(copseCacheDir(env), 'native-build', '.cache'),
    npm_config_ignore_scripts: 'true',
    npm_config_engine_strict: 'true',
    YARN_ENABLE_SCRIPTS: 'false',
  }
}

function environmentForPlan(
  env: NodeJS.ProcessEnv,
  plan: WorktreePreparationPlan,
  offline: boolean,
): NodeJS.ProcessEnv {
  const inherited =
    plan.ecosystem === 'cargo'
      ? Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:CARGO|RUST)/.test(key)))
      : { ...env }
  const rustBin =
    plan.ecosystem === 'cargo' ? resolveInstalledRustToolchainBin(plan.root, env) : null
  const result: NodeJS.ProcessEnv = {
    ...inherited,
    // Explicit versions are selected through Corepack; do not rewrite package.json.
    COREPACK_ENABLE_AUTO_PIN: '0',
    COREPACK_ENABLE_NETWORK: offline ? '0' : '1',
    ...(plan.ecosystem === 'uv'
      ? {
          UV_PROJECT_ENVIRONMENT: join(plan.root, '.venv'),
          UV_PYTHON_DOWNLOADS: 'never',
          UV_OFFLINE: offline ? 'true' : 'false',
          PYTHONDONTWRITEBYTECODE: '1',
        }
      : {}),
    ...(plan.ecosystem === 'go'
      ? {
          GOENV: 'off',
          GOTOOLCHAIN: 'local',
          GOFLAGS: '-mod=readonly',
          GOWORK: existsSync(join(plan.root, 'go.work')) ? join(plan.root, 'go.work') : 'off',
          GOPROXY: offline ? 'off' : (env['GOPROXY'] ?? 'https://proxy.golang.org,direct'),
        }
      : {}),
    ...(plan.ecosystem === 'cargo'
      ? {
          CARGO_HOME: join(copseCacheDir(env), 'cargo'),
          CARGO_NET_OFFLINE: offline ? 'true' : 'false',
          CARGO_CACHE_AUTO_CLEAN_FREQUENCY: 'never',
          RUSTUP_AUTO_INSTALL: '0',
          // Exclude rustup proxies and project/ambient wrappers. The adapter
          // uses only the canonical, already-installed toolchain resolved above.
          PATH: rustBin ?? '',
          ...(rustBin
            ? {
                [cargoExecutableEnv]: join(rustBin, 'cargo'),
                [rustcExecutableEnv]: join(rustBin, 'rustc'),
              }
            : {}),
        }
      : {}),
    ...(plan.manager?.name === 'yarn' && plan.manager.modernYarn
      ? {
          YARN_ENABLE_NETWORK: offline ? 'false' : 'true',
          YARN_ENABLE_SCRIPTS: 'false',
          YARN_ENABLE_IMMUTABLE_INSTALLS: 'true',
        }
      : {}),
  }
  return result
}

function executableForPlan(
  plan: WorktreePreparationPlan,
  command: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (plan.ecosystem !== 'cargo') return command
  if (command === 'cargo') return env[cargoExecutableEnv] ?? null
  if (command === 'rustc') return env[rustcExecutableEnv] ?? null
  return command
}

function readStamp(root: string): string | null {
  try {
    const path = containedPreparationPath(root, PREPARATION_STAMP)
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (!stat) return null
    if (!stat.isFile() || stat.size > 128) return 'invalid'
    return readFileSync(path, 'utf8').trim()
  } catch {
    return 'invalid'
  }
}

async function inspectPlan(
  plan: WorktreePreparationPlan,
  options: InspectOptions,
): Promise<WorktreePreparationReport> {
  const env = environmentForPlan(preparationEnvironment(options.env), plan, true)
  const probeFailures: string[] = []
  const probe =
    options.probe ??
    sandboxProbe(
      plan.root,
      undefined,
      (message) => {
        probeFailures.push(message)
      },
      plan.ecosystem === 'go',
      plan.ecosystem === 'cargo',
    )
  const components: WorktreePreparationComponent[] = []
  const identity: string[] = [plan.fingerprint, process.platform, process.arch]
  if (plan.manager) {
    const runtime = await probe(
      'node',
      ['-p', 'process.versions.node + "\\n" + process.versions.modules'],
      env,
    )
    const node = runtime?.split(/\r?\n/)[0] ?? ''
    // Bun projects may not use Node. Their runtime identity is the Bun version below.
    const needsNode = plan.manager.name !== 'bun' || plan.nodeRequirements.length > 0
    if (needsNode) {
      identity.push(runtime ?? 'node unavailable')
      const requirements = plan.nodeRequirements.map((requirement) => requirement.replace(/^v/, ''))
      const ready =
        valid(node) !== null &&
        requirements.every(
          (requirement) => validRange(requirement) !== null && satisfies(node, requirement),
        )
      components.push({
        name: 'Node',
        ready,
        detail: `found ${node || 'unavailable'}${requirements.length ? `; requires ${requirements.join(' and ')}` : '; no project version constraint'}`,
      })
    }
    const invocation = packageManagerCommand(plan)
    const version = invocation
      ? await probe(invocation.command, [...invocation.args, '--version'], env)
      : null
    identity.push(version ?? 'package manager unavailable')
    const versionReady =
      version !== null &&
      valid(version) !== null &&
      (!plan.manager.version || version === plan.manager.version)
    const yarnFamilyMatches =
      plan.manager.name !== 'yarn' ||
      Number(version?.split('.')[0] ?? 0) >= 2 === plan.manager.modernYarn
    components.push({
      name: 'Package manager',
      ready: versionReady && yarnFamilyMatches,
      detail: `${plan.manager.name}: found ${version ?? 'unavailable'}${plan.manager.version ? `; requires ${plan.manager.version}` : `; selected by ${plan.manager.lockfile}`}`,
    })
    const missing = plan.dependencyGroups.flatMap(({ manifest, names }) =>
      names.flatMap((name) => {
        if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name))
          return [`${manifest}: invalid package name`]
        let directory = dirname(join(plan.root, manifest))
        for (;;) {
          if (existsSync(join(directory, 'node_modules', name, 'package.json'))) return []
          if (directory === plan.root) return [`${manifest}: ${name}`]
          directory = dirname(directory)
        }
      }),
    )
    const pnp =
      plan.manager.name === 'yarn' && plan.manager.modernYarn
        ? ['.pnp.cjs', '.pnp.js'].find((file) => existsSync(join(plan.root, file)))
        : undefined
    // Check each workspace issuer using the generated PnP resolver, including its archives.
    const pnpReady =
      pnp !== undefined &&
      (await probe(
        'node',
        [
          '--require',
          `./${pnp}`,
          '-e',
          'const p=require(process.argv[2]),fs=require("fs"),path=require("path");for(const g of JSON.parse(process.argv[1]))for(const n of g.names){const target=p.resolveToUnqualified(n,path.resolve(g.manifest));if(!target||!fs.existsSync(target))process.exit(1)}console.log("ready")',
          JSON.stringify(plan.dependencyGroups),
          `./${pnp}`,
        ],
        env,
      )) === 'ready'
    components.push({
      name: 'Dependencies',
      ready: pnp ? pnpReady : missing.length === 0,
      detail: pnp
        ? 'Yarn Plug’n’Play resolver'
        : missing.length
          ? `missing ${missing.join(', ')}`
          : 'declared direct dependencies present',
    })
  }
  for (const check of plan.checks) {
    probeFailures.length = 0
    const pathReady = check.path === undefined || existsSync(join(plan.root, check.path))
    const checkExecutable = check.command
      ? executableForPlan(plan, check.command.command, env)
      : null
    const output =
      check.command && checkExecutable
        ? await probe(checkExecutable, check.command.args, env)
        : null
    if (check.fingerprintOutput) identity.push(check.name, output ?? 'unavailable')
    const commandReady =
      !check.command ||
      (output !== null && (!check.outputIncludes || output.includes(check.outputIncludes)))
    components.push({
      name: check.name,
      ready: pathReady && commandReady,
      detail: !pathReady
        ? `missing ${check.path ?? ''}`
        : !commandReady
          ? (probeFailures.at(-1) ?? 'read-only check failed or expected output was absent')
          : (check.path ?? output?.slice(0, 300) ?? 'check passed'),
    })
  }
  if (!components.length)
    components.push({
      name: 'Project setup',
      ready: true,
      detail: 'No dependency installation or additional checks declared.',
    })
  const expectedFingerprint = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  const stamp = readStamp(plan.root)
  const allReady = components.every((component) => component.ready)
  const noWork = !plan.manager && plan.prepare.length === 0 && plan.checks.length === 0
  let state: WorktreePreparationState
  if (plan.problems.length) state = 'needs-configuration'
  else if (allReady && (stamp === expectedFingerprint || noWork)) state = 'ready'
  else if (options.offline) state = 'unavailable-offline'
  else if (stamp !== null && !/^[a-f0-9]{64}$/.test(stamp)) state = 'corrupt'
  else if (stamp !== null && stamp !== expectedFingerprint) state = 'stale'
  else if (stamp === expectedFingerprint) state = 'corrupt'
  else state = 'absent'
  const remediation =
    state === 'ready'
      ? 'No preparation needed. Readiness covers dependencies and declared checks, not build or test success.'
      : state === 'needs-configuration'
        ? plan.problems.join(' ')
        : state === 'unavailable-offline'
          ? 'Restore matching cached inputs or reconnect, then run prepare_worktree with this plan fingerprint.'
          : 'Run prepare_worktree once with this plan fingerprint. Install the required runtime/package-manager version first if unavailable; declare any additional native setup and checks explicitly.'
  return {
    state,
    planFingerprint: plan.fingerprint,
    expectedFingerprint,
    components,
    plan: formatPreparationPlan(plan, options.offline === true),
    remediation,
  }
}

export async function inspectWorktreePreparation(
  root: string,
  options: InspectOptions = {},
): Promise<WorktreePreparationReport> {
  if (!options.probe) requirePreparationSandbox()
  return inspectPlan(readWorktreePreparationPlan(root), options)
}

export function assertPreparationPlan(root: string, fingerprint: string): WorktreePreparationPlan {
  const plan = readWorktreePreparationPlan(root)
  if (plan.fingerprint !== fingerprint)
    throw new Error(
      'Preparation plan changed. Run preflight_worktree again and approve the updated plan.',
    )
  if (plan.problems.length) throw new Error(plan.problems.join(' '))
  return plan
}

export async function prepareWorktree(
  root: string,
  options: PrepareOptions,
): Promise<WorktreePreparationReport> {
  requirePreparationSandbox()
  const plan = assertPreparationPlan(root, options.planFingerprint)
  containedPreparationPath(root, PREPARATION_STAMP)
  const before = await inspectPlan(plan, options)
  if (before.state === 'ready') return before
  const offline = options.offline === true
  const env = environmentForPlan(preparationEnvironment(options.env), plan, offline)
  const run = async (
    step: PreparationCommand,
    childEnv = env,
    additionalExecutables: string[] = [],
  ): Promise<void> => {
    options.signal.throwIfAborted()
    assertPreparationPlan(root, options.planFingerprint)
    const executable = executableForPlan(plan, step.command, childEnv)
    if (!executable) throw new Error('The selected installed Cargo toolchain is unavailable.')
    emitShellOutput(`[prepare-worktree] ${JSON.stringify([step.command, ...step.args])}\n`)
    await runWorktreePreparationProcess(executable, step.args, {
      root,
      env: childEnv,
      mode: 'prepare',
      offline,
      signal: options.signal,
      output: emitShellOutput,
      additionalExecutables,
      ...(plan.ecosystem === 'go' && step.command === 'go' ? { projectWritable: false } : {}),
      ...(plan.ecosystem === 'cargo' && step.command === 'cargo'
        ? { projectWritable: false, cargoAdapter: true }
        : {}),
      goBookkeeping: plan.ecosystem === 'go' && step.command === 'go',
    })
  }
  // Host runtime is only used for fixed file operations; non-Node projects need no Node install.
  // The packaged macOS app cannot run as Node (RunAsNode fuse off), so this uses
  // the separately shipped worker interpreter.
  const fileOperation = async (args: string[]): Promise<void> =>
    run({ command: nodeWorkerExecutable(), args }, { ...env, ELECTRON_RUN_AS_NODE: '1' })
  await fileOperation([
    '-e',
    'require("node:fs").mkdirSync(process.argv[1],{recursive:true})',
    join(root, '.tmp', 'worktree-preparation'),
  ])
  const install = packageInstallCommand(plan, offline)
  try {
    if (install) {
      // npm and Bun are host-installed tools; do not silently install a different runtime.
      const runtimeProblem = before.components.find(
        (component) =>
          (component.name === 'Node' ||
            (component.name === 'Package manager' &&
              (plan.manager?.name === 'npm' || plan.manager?.name === 'bun'))) &&
          !component.ready,
      )
      if (runtimeProblem) throw new Error(runtimeProblem.detail)
      const firewallRoot = join(copseCacheDir(env), 'socket-firewall')
      const firewall = join(firewallRoot, 'bin', 'sfw')
      const probe = options.probe ?? sandboxProbe(root, options.signal)
      if ((await probe(firewall, ['--version'], env)) === null) {
        if (offline) throw new Error('Socket Firewall is not installed in the managed cache.')
        await run({ command: 'npm', args: [...sfwInstallArgs(), '--prefix', firewallRoot] })
      }
      // Yarn 2/3 reject the newer Yarn CA setting emitted by SFW. Retain its
      // proxy and NODE_EXTRA_CA_CERTS; remove only the unknown setting name.
      const compatibility =
        plan.manager?.modernYarn && Number(plan.manager.version?.split('.')[0]) < 4
          ? ['/usr/bin/env', '-u', 'YARN_HTTPS_CA_FILE_PATH']
          : []
      await run(
        { command: firewall, args: [...compatibility, install.command, ...install.args] },
        env,
        [install.command],
      )
    }
    for (const step of plan.prepare) await run(step)
  } catch (error) {
    if (offline)
      throw new Error(`Preparation unavailable offline: ${errorMessage(error)}`, { cause: error })
    throw error
  }
  assertPreparationPlan(root, options.planFingerprint)
  const validation = await inspectPlan(plan, options)
  if (!validation.components.every((component) => component.ready))
    throw new Error(
      `Preparation validation failed:\n${formatWorktreePreparationReport(validation)}`,
    )
  await fileOperation([
    '-e',
    'require("node:fs").writeFileSync(process.argv[1],process.argv[2]+"\\n")',
    join(root, PREPARATION_STAMP),
    validation.expectedFingerprint,
  ])
  const complete = await inspectPlan(plan, options)
  if (complete.state !== 'ready')
    throw new Error(
      `Preparation did not produce a ready worktree:\n${formatWorktreePreparationReport(complete)}`,
    )
  return complete
}

export function formatWorktreePreparationReport(report: WorktreePreparationReport): string {
  return [
    `Worktree preparation: ${report.state}`,
    report.plan,
    ...report.components.map(
      (component) =>
        `- ${component.ready ? 'ready' : 'not ready'} — ${component.name}: ${component.detail}`,
    ),
    `Remediation: ${report.remediation}`,
  ].join('\n')
}
