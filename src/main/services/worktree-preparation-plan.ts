import { formatArgvForShell } from '../project-sandbox/sandbox-argv.ts'
import { load } from 'js-yaml'
import { createHash } from 'node:crypto'
import { existsSync, globSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { fingerprintPaths } from '../../../scripts/lib/dev-sync.mts'

export const PREPARATION_CONFIG = '.copse/worktree-preparation.json'
export const PREPARATION_STAMP = '.tmp/worktree-preparation.fingerprint'
const string = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'))
const commandSchema = z
  .object({ command: string, args: z.array(string).max(100).default([]) })
  .strict()
const checkSchema = z
  .object({
    name: string,
    path: string.optional(),
    command: commandSchema.optional(),
    outputIncludes: string.optional(),
    fingerprintOutput: z.boolean().default(false),
  })
  .strict()
  .refine(
    (check) => check.path !== undefined || check.command !== undefined,
    'A check needs a path or command',
  )
const configSchema = z
  .object({
    version: z.literal(1),
    inputs: z.array(string).max(200).default([]),
    prepare: z.array(commandSchema).max(30).default([]),
    checks: z.array(checkSchema).max(30).default([]),
  })
  .strict()
const packageSchema = z.object({
  packageManager: z.string().optional(),
  workspaces: z
    .union([z.array(z.string()), z.object({ packages: z.array(z.string()) })])
    .optional(),
  engines: z.object({ node: z.string().optional() }).optional(),
  dependencies: z.record(z.string(), z.string()).default({}),
  devDependencies: z.record(z.string(), z.string()).default({}),
  optionalDependencies: z.record(z.string(), z.string()).default({}),
})

export type PreparationCommand = z.infer<typeof commandSchema>
export type PreparationCheck = z.infer<typeof checkSchema>
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'
export interface WorktreePreparationPlan {
  root: string
  fingerprint: string
  manager: {
    name: PackageManager
    version: string | null
    modernYarn: boolean
    lockfile: string
  } | null
  nodeRequirements: string[]
  manifests: string[]
  dependencyGroups: Array<{ manifest: string; names: string[] }>
  prepare: PreparationCommand[]
  checks: PreparationCheck[]
  problems: string[]
}

export function readPreparationText(root: string, path: string): string | null {
  if (!existsSync(join(root, path))) return null
  containedPreparationPath(root, path)
  return readFileSync(join(root, path), 'utf8').trim()
}

/** Metadata and declared inputs must not make host reads follow links out of the checkout. */
function relativePreparationPath(root: string, path: string): string {
  const absolute = resolve(root, path)
  const rel = relative(root, absolute)
  if (isAbsolute(path) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`Preparation path must stay in the worktree: ${path}`)
  }
  return absolute
}

export function containedPreparationPath(root: string, path: string): string {
  const absolute = relativePreparationPath(root, path)
  if (existsSync(absolute)) {
    const canonical = relative(realpathSync(root), realpathSync(absolute))
    if (canonical === '..' || canonical.startsWith(`..${sep}`) || isAbsolute(canonical)) {
      throw new Error(`Preparation input points outside the worktree: ${path}`)
    }
  }
  return absolute
}

const locks: Array<[PackageManager, string[]]> = [
  ['npm', ['npm-shrinkwrap.json', 'package-lock.json']],
  ['pnpm', ['pnpm-lock.yaml']],
  ['yarn', ['yarn.lock']],
  ['bun', ['bun.lock', 'bun.lockb']],
]

function parseWorkspacePatterns(text: string): string[] | null {
  try {
    const parsed = z.object({ packages: z.array(z.string()).default([]) }).safeParse(load(text))
    return parsed.success ? parsed.data.packages : null
  } catch {
    return null
  }
}

export function readWorktreePreparationPlan(root: string): WorktreePreparationPlan {
  root = realpathSync(root)
  const problems: string[] = []
  const configText = readPreparationText(root, PREPARATION_CONFIG)
  const config =
    configText === null ? null : safeJsonParse(configText, decodeWithSchema(configSchema))
  if (configText !== null && !config)
    problems.push(
      `Invalid ${PREPARATION_CONFIG}; expected version 1 with argv-based prepare steps and checks.`,
    )
  const pkgText = readPreparationText(root, 'package.json')
  const pkg = pkgText === null ? null : safeJsonParse(pkgText, decodeWithSchema(packageSchema))
  if (pkgText !== null && !pkg) problems.push('Invalid package.json.')
  let manager: WorktreePreparationPlan['manager'] = null
  if (pkg) {
    const pin = pkg.packageManager?.match(
      /^(npm|pnpm|yarn|bun)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[^\s]+)?$/,
    )
    const candidates = locks.flatMap(([name, names]) => {
      const lockfile = names.find((path) => existsSync(join(root, path)))
      return lockfile ? [{ name, lockfile }] : []
    })
    if (pkg.packageManager && !pin)
      problems.push(
        `Unsupported packageManager pin: ${pkg.packageManager}. Use an exact npm, pnpm, yarn, or bun version.`,
      )
    const selected = pin
      ? candidates.find((candidate) => candidate.name === pin[1])
      : candidates.length === 1
        ? candidates[0]
        : undefined
    if (!selected) {
      problems.push(
        candidates.length > 1 && !pin
          ? 'Conflicting lockfiles; declare packageManager to select the intended installer.'
          : 'A matching lockfile is required. Generate and review it with the intended package manager first.',
      )
    } else {
      const yarnLock =
        selected.name === 'yarn' ? readPreparationText(root, selected.lockfile) : null
      manager = {
        ...selected,
        version: pin?.[2] ?? null,
        modernYarn:
          selected.name === 'yarn' &&
          (pin ? Number(pin[2]?.split('.')[0]) >= 2 : /^__metadata:/m.test(yarnLock ?? '')),
      }
    }
  } else if (pkgText === null && !config) {
    problems.push(
      `No automatic package-manager adapter found. Declare this project's setup commands, inputs, and checks in ${PREPARATION_CONFIG}; an empty declaration explicitly means no setup is needed.`,
    )
  }

  if (manager?.modernYarn && manager.version === null) {
    problems.push(
      'Declare an exact packageManager version for modern Yarn so its build-disabling flags are unambiguous.',
    )
  }
  let workspacePatterns = pkg?.workspaces
    ? Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : pkg.workspaces.packages
    : []
  const workspaceYaml = readPreparationText(root, 'pnpm-workspace.yaml')
  if (manager?.name === 'pnpm' && workspaceYaml !== null) {
    const patterns = parseWorkspacePatterns(workspaceYaml)
    if (!patterns) problems.push('Invalid pnpm workspace package patterns.')
    else workspacePatterns = patterns
  }
  for (const pattern of workspacePatterns) containedPreparationPath(root, pattern.replace(/^!/, ''))
  const patterns = workspacePatterns
    .filter((pattern) => !pattern.startsWith('!'))
    .map((pattern) => `${pattern.replace(/\/$/, '')}/package.json`)
  const exclusions = workspacePatterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => `${pattern.slice(1).replace(/\/$/, '')}/package.json`)
  const manifests = pkg
    ? [
        ...new Set([
          'package.json',
          ...globSync(patterns, {
            cwd: root,
            exclude: ['**/node_modules/**', '**/.git/**', '**/.tmp/**', ...exclusions],
          }),
        ]),
      ].sort()
    : []
  if (manifests.length > 10000) throw new Error('Too many project manifests to fingerprint safely.')
  const inputs = [
    ...manifests,
    PREPARATION_CONFIG,
    '.nvmrc',
    '.node-version',
    '.npmrc',
    '.pnpmfile.cjs',
    'pnpmfile.cjs',
    'pnpm-workspace.yaml',
    '.yarnrc',
    '.yarnrc.yml',
    '.yarn/plugins',
    '.yarn/releases',
    'bunfig.toml',
    'patches',
    '.yarn/patches',
    ...locks.flatMap(([, names]) => names),
    ...(config?.inputs ?? []),
  ]
  for (const input of inputs) containedPreparationPath(root, input)
  for (const check of config?.checks ?? [])
    if (check.path) relativePreparationPath(root, check.path)
  const fingerprint = createHash('sha256')
    .update('worktree-plan-v2\0')
    .update(root)
    .update(
      fingerprintPaths(
        root,
        inputs.flatMap((path) =>
          existsSync(join(root, path))
            ? [path, relative(root, realpathSync(join(root, path)))]
            : [path],
        ),
      ),
    )
    .digest('hex')
  const nodeRequirements = [
    readPreparationText(root, '.nvmrc'),
    readPreparationText(root, '.node-version'),
    pkg?.engines?.node,
  ].flatMap((value) => (typeof value === 'string' && value.length > 0 ? [value] : []))
  return {
    root,
    fingerprint,
    manager,
    nodeRequirements,
    manifests,
    dependencyGroups: manifests.map((manifest) => {
      const text = readPreparationText(root, manifest)
      const data = text === null ? null : safeJsonParse(text, decodeWithSchema(packageSchema))
      if (!data) throw new Error(`Invalid project manifest: ${manifest}`)
      return {
        manifest,
        names: Object.keys({ ...data.dependencies, ...data.devDependencies }).filter(
          (name) => !Object.hasOwn(data.optionalDependencies, name),
        ),
      }
    }),
    prepare: config?.prepare ?? [],
    checks: config?.checks ?? [],
    problems,
  }
}

export function packageManagerCommand(plan: WorktreePreparationPlan): PreparationCommand | null {
  if (!plan.manager) return null
  const { name, version } = plan.manager
  if (name === 'pnpm' || name === 'yarn') {
    return { command: 'corepack', args: [version ? `${name}@${version}` : name] }
  }
  return { command: name, args: [] }
}

export function packageInstallCommand(
  plan: WorktreePreparationPlan,
  offline: boolean,
): PreparationCommand | null {
  const invocation = packageManagerCommand(plan)
  if (!invocation || !plan.manager) return null
  let args: string[]
  switch (plan.manager.name) {
    case 'npm':
      args = [
        'ci',
        '--ignore-scripts',
        '--include=dev',
        '--no-audit',
        '--no-fund',
        ...(offline ? ['--offline'] : []),
      ]
      break
    case 'pnpm':
      args = [
        'install',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--prod=false',
        ...(!existsSync(join(plan.root, 'pnpm-workspace.yaml')) ? ['--ignore-workspace'] : []),
        ...(offline ? ['--offline'] : []),
      ]
      break
    case 'yarn':
      args = plan.manager.modernYarn
        ? [
            'install',
            '--immutable',
            Number(plan.manager.version?.split('.')[0]) === 2
              ? '--skip-builds'
              : '--mode=skip-build',
          ]
        : [
            'install',
            '--frozen-lockfile',
            '--ignore-scripts',
            '--non-interactive',
            '--production=false',
            ...(offline ? ['--offline'] : []),
          ]
      break
    case 'bun':
      args = ['install', '--frozen-lockfile', '--ignore-scripts']
      break
  }
  return { command: invocation.command, args: [...invocation.args, ...args] }
}

export function formatPreparationPlan(plan: WorktreePreparationPlan, offline: boolean): string {
  const install = packageInstallCommand(plan, offline)
  return [
    `Project: ${plan.root}`,
    `Plan fingerprint: ${plan.fingerprint}`,
    `Package manager: ${plan.manager ? `${plan.manager.name}${plan.manager.version ? `@${plan.manager.version}` : ' (version detected locally)'}` : 'project-defined setup'}`,
    ...(install
      ? [
          `Install through Socket Firewall: ${JSON.stringify([install.command, ...install.args])} (dependency lifecycle scripts disabled)`,
        ]
      : []),
    ...plan.prepare.map(
      (step) =>
        `Project setup (executes repository code): ${JSON.stringify([step.command, ...step.args])}`,
    ),
    ...plan.checks.map(
      (check) =>
        `Read-only check: ${check.name}${check.path ? ` — ${check.path}` : ''}${check.command ? ` — ${JSON.stringify([check.command.command, ...check.command.args])}` : ''}`,
    ),
    ...plan.problems.map((problem) => `Needs configuration: ${problem}`),
    `Network: ${offline ? 'blocked for every subprocess' : 'allowed during preparation; checks remain offline'}. Writes: active worktree and Copse-managed caches only. No unsandboxed fallback.`,
  ].join('\n')
}

export function formatPreparationApproval(
  plan: WorktreePreparationPlan,
  offline: boolean,
): { body: string; bodyAdvice: string; bodyFooter: string } {
  const install = packageInstallCommand(plan, offline)
  return {
    body:
      [
        ...(install
          ? ['Install through Socket Firewall:', formatArgvForShell(install.command, install.args)]
          : []),
        ...(plan.prepare.length
          ? [
              'Project setup:',
              ...plan.prepare.map((step) => formatArgvForShell(step.command, step.args)),
            ]
          : []),
      ].join('\n') || 'No setup commands; validate the declared checks.',
    bodyAdvice: [
      ...(install ? ['Install locked dependencies with lifecycle scripts disabled.'] : []),
      ...(plan.prepare.length ? ['Project setup executes repository code.'] : []),
    ].join(' '),
    bodyFooter: `Network: ${offline ? 'blocked for every subprocess' : 'allowed during preparation; checks stay offline'}. Writes are limited to this project and Copse-managed caches.\nProject: ${plan.root}`,
  }
}
