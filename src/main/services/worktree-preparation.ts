import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { satisfies, valid, validRange } from 'semver'
import { errorMessage } from '@shared/errors.ts'
import { copseCacheDir } from './storage/copse-paths.ts'
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
      signal?.throwIfAborted()
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
    electron_config_cache: join(root, 'electron-downloads'),
    COPSE_ELECTRON_DIST_CACHE: join(root, 'electron-dist'),
    COPSE_GORTEX_CACHE: join(root, 'gortex'),
  }
}

export function worktreePreparationShellEnvironment(
  root: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!existsSync(root)) return env
  try {
    const plan = readWorktreePreparationPlan(root)
    return plan.problems.length === 0 ? preparationCacheEnvironment(env) : env
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
  return {
    ...env,
    // Explicit versions are selected through Corepack; do not rewrite package.json.
    COREPACK_ENABLE_AUTO_PIN: '0',
    COREPACK_ENABLE_NETWORK: offline ? '0' : '1',
    ...(plan.manager?.name === 'yarn' && plan.manager.modernYarn
      ? {
          YARN_ENABLE_NETWORK: offline ? 'false' : 'true',
          YARN_ENABLE_SCRIPTS: 'false',
          YARN_ENABLE_IMMUTABLE_INSTALLS: 'true',
        }
      : {}),
  }
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
  const probe = options.probe ?? sandboxProbe(plan.root)
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
    const pathReady = check.path === undefined || existsSync(join(plan.root, check.path))
    const output = check.command
      ? await probe(check.command.command, check.command.args, env)
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
          ? 'read-only check failed or expected output was absent'
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
    emitShellOutput(`[prepare-worktree] ${JSON.stringify([step.command, ...step.args])}\n`)
    await runWorktreePreparationProcess(step.command, step.args, {
      root,
      env: childEnv,
      mode: 'prepare',
      offline,
      signal: options.signal,
      output: emitShellOutput,
      additionalExecutables,
    })
  }
  // Host runtime is only used for fixed file operations; non-Node projects need no Node install.
  const fileOperation = async (args: string[]): Promise<void> =>
    run({ command: process.execPath, args }, { ...env, ELECTRON_RUN_AS_NODE: '1' })
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
