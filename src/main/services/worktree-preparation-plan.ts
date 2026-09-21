import { formatArgvForShell } from '../project-sandbox/sandbox-argv.ts'
import { load } from 'js-yaml'
import { createHash } from 'node:crypto'
import { existsSync, globSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
  ecosystem: 'uv' | 'go' | 'cargo' | null
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
  // Inspect the deepest existing ancestor even when the output is absent.
  // lstat also sees dangling links, which must fail closed rather than make a
  // host write (or a Linux namespace-only write) follow an unchecked target.
  let ancestor = absolute
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = dirname(ancestor)
  const canonical = relative(realpathSync(root), realpathSync(ancestor))
  if (canonical === '..' || canonical.startsWith(`..${sep}`) || isAbsolute(canonical)) {
    throw new Error(`Preparation input points outside the worktree: ${path}`)
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

function goDirectiveTokens(line: string): string[] {
  let quoted = false
  let raw = false
  let escaped = false
  let end = line.length
  for (let index = 0; index < line.length - 1; index++) {
    const character = line[index]
    if (escaped) escaped = false
    else if (quoted && character === '\\') escaped = true
    else if (!raw && character === '"') quoted = !quoted
    else if (!quoted && character === '`') raw = !raw
    else if (!quoted && !raw && character === '/' && line[index + 1] === '/') {
      end = index
      break
    }
  }
  return (line.slice(0, end).match(/"(?:\\.|[^"\\])*"|`[^`]*`|=>|[()]|[^\s()]+/g) ?? []).map(
    (token) => {
      if (token.startsWith('"')) {
        try {
          const parsed: unknown = JSON.parse(token)
          return typeof parsed === 'string' ? parsed : token
        } catch {
          return token
        }
      }
      return token.startsWith('`') ? token.slice(1, -1) : token
    },
  )
}

/** Local Go workspace/module paths must stay within the selected checkout. */
function validateGoLocalPaths(root: string, manifest: string): void {
  const text = readPreparationText(root, manifest)
  if (text === null) return
  let useBlock = false
  for (const line of text.split(/\r?\n/)) {
    const tokens = goDirectiveTokens(line)
    if (!tokens.length) continue
    const close = tokens.includes(')')
    if (tokens[0] === 'use') {
      useBlock = tokens.includes('(')
      const candidate = tokens.find((token, index) => index > 0 && token !== '(' && token !== ')')
      if (candidate) validateGoContainedPath(root, manifest, candidate)
    } else if (useBlock && tokens[0] !== ')') {
      validateGoContainedPath(root, manifest, tokens[0] ?? '')
    }
    const arrow = tokens.indexOf('=>')
    if (arrow >= 0) {
      const candidate = tokens[arrow + 1]
      if (candidate?.startsWith('.') || candidate?.startsWith('/'))
        validateGoContainedPath(root, manifest, candidate)
    }
    if (close) {
      useBlock = false
    }
  }
}

function validateGoContainedPath(root: string, manifest: string, path: string): void {
  const fromRoot = relative(root, resolve(dirname(join(root, manifest)), path))
  containedPreparationPath(root, fromRoot)
}

/** Automatic Cargo preparation never executes project-selected helpers or credentials. */
function validateCargoConfig(root: string, path: string, problems: string[]): void {
  const text = readPreparationText(root, path)
  if (text === null) return
  problems.push(
    `${path} can change Cargo executables, credentials, environment, or sources; declare Cargo setup explicitly after reviewing it.`,
  )
}

function findCargoAncestorConfig(root: string): string | null {
  for (let directory = dirname(root); ; directory = dirname(directory)) {
    for (const name of ['config.toml', 'config']) {
      const path = join(directory, '.cargo', name)
      if (lstatSync(path, { throwIfNoEntry: false })) return path
    }
    if (dirname(directory) === directory) return null
  }
}

function findCargoAncestorManifest(root: string): string | null {
  for (let directory = dirname(root); ; directory = dirname(directory)) {
    const path = join(directory, 'Cargo.toml')
    if (lstatSync(path, { throwIfNoEntry: false })) return path
    if (dirname(directory) === directory) return null
  }
}

/** Automatic Cargo currently supports only manifests without local graph declarations. */
function validateCargoManifestBoundary(root: string, manifest: string, problems: string[]): void {
  const text = readPreparationText(root, manifest)
  if (text === null) return
  // Without a TOML parser, accepting any path/workspace syntax would make
  // containment depend on an incomplete textual grammar. False positives are
  // deliberately routed to the existing reviewed declaration path.
  if (/(?:path|workspace)/i.test(text) || text.includes('\\')) {
    problems.push(
      `${manifest} contains local path/workspace text or escaped syntax; automatic Cargo supports a narrow unescaped registry/Git manifest subset only. Declare Cargo setup explicitly after review.`,
    )
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
  // An explicit declaration owns non-JavaScript setup. Mixed roots must choose
  // deliberately; executable availability is never package-manager selection.
  const uvProject = existsSync(join(root, 'uv.lock'))
  const goProject = existsSync(join(root, 'go.mod')) || existsSync(join(root, 'go.work'))
  const cargoProject = existsSync(join(root, 'Cargo.toml'))
  const automaticEcosystems = [
    pkg ? 'JavaScript' : null,
    uvProject ? 'Python' : null,
    goProject ? 'Go' : null,
    cargoProject ? 'Rust' : null,
  ].filter(Boolean)
  const ecosystem =
    !pkg && !config
      ? uvProject && !goProject && !cargoProject
        ? 'uv'
        : goProject && !uvProject && !cargoProject
          ? 'go'
          : cargoProject && !uvProject && !goProject
            ? 'cargo'
            : null
      : null
  if (automaticEcosystems.length > 1 && !config)
    problems.push(
      `Multiple ecosystems found; declare their setup in ${PREPARATION_CONFIG} or select a nested project.`,
    )
  if (ecosystem === 'uv' && !existsSync(join(root, 'pyproject.toml')))
    problems.push('uv.lock requires a pyproject.toml in the selected project.')
  if (
    ecosystem === 'uv' &&
    ['poetry.lock', 'Pipfile.lock'].some((file) => existsSync(join(root, file)))
  )
    problems.push(
      `Conflicting Python lockfiles; select the intended setup in ${PREPARATION_CONFIG}.`,
    )
  if (
    !config &&
    !goProject &&
    (existsSync(join(root, 'go.sum')) || existsSync(join(root, 'go.work.sum')))
  )
    problems.push('Go checksum files require a go.mod or go.work in the selected project.')
  if (ecosystem === 'cargo' && !existsSync(join(root, 'Cargo.lock')))
    problems.push('Cargo.toml requires a reviewed Cargo.lock for automatic preparation.')
  if (!config && !cargoProject && existsSync(join(root, 'Cargo.lock')))
    problems.push('Cargo.lock requires a Cargo.toml in the selected project.')
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
  } else if (pkgText === null && !config && !ecosystem && automaticEcosystems.length === 0) {
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
  const goManifests =
    ecosystem === 'go'
      ? globSync(['**/go.mod', '**/go.sum'], {
          cwd: root,
          exclude: ['**/vendor/**', '**/node_modules/**', '**/.git/**', '**/.tmp/**'],
        }).sort()
      : []
  const goSources =
    ecosystem === 'go'
      ? globSync(['**/*.go'], {
          cwd: root,
          exclude: ['**/vendor/**', '**/node_modules/**', '**/.git/**', '**/.tmp/**'],
        }).sort()
      : []
  const cargoManifests =
    ecosystem === 'cargo'
      ? globSync(['**/Cargo.toml'], {
          cwd: root,
          exclude: ['**/target/**', '**/node_modules/**', '**/.git/**', '**/.tmp/**'],
        }).sort()
      : []
  if (goManifests.length + goSources.length > 20000)
    throw new Error('Too many Go project inputs to fingerprint safely.')
  if (ecosystem === 'go') {
    for (const manifest of goManifests.filter((path) => path.endsWith('go.mod')))
      validateGoLocalPaths(root, manifest)
    if (existsSync(join(root, 'go.work'))) validateGoLocalPaths(root, 'go.work')
  }
  if (cargoManifests.length > 10000)
    throw new Error('Too many Cargo manifests to fingerprint safely.')
  if (ecosystem === 'cargo') {
    for (const manifest of cargoManifests) validateCargoManifestBoundary(root, manifest, problems)
    for (const path of ['.cargo/config.toml', '.cargo/config'])
      validateCargoConfig(root, path, problems)
    if (existsSync(join(root, '.cargo/config.toml')) && existsSync(join(root, '.cargo/config')))
      problems.push(
        'Conflicting .cargo/config.toml and .cargo/config files; retain one reviewed Cargo configuration.',
      )
    const ancestorConfig = findCargoAncestorConfig(root)
    if (ancestorConfig)
      problems.push(
        `Cargo configuration outside the selected project is not used automatically (${ancestorConfig}); select a project above it or declare setup explicitly.`,
      )
    const ancestorManifest = findCargoAncestorManifest(root)
    if (ancestorManifest)
      problems.push(
        `An enclosing Cargo.toml may select a workspace outside this project (${ancestorManifest}); select that project or declare setup explicitly.`,
      )
    if (existsSync(join(root, 'rust-toolchain.toml')))
      problems.push(
        'rust-toolchain.toml requires parsed TOML selection; declare Cargo setup explicitly or use a bounded plain rust-toolchain channel.',
      )
    const legacyToolchain = readPreparationText(root, 'rust-toolchain')
    if (
      legacyToolchain !== null &&
      (legacyToolchain.length > 128 || !/^[A-Za-z0-9._-]+$/.test(legacyToolchain))
    )
      problems.push('rust-toolchain must contain one bounded installed channel name.')
  }
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
    // Include detection inputs even when absent so adding another ecosystem or
    // a conflicting lock invalidates an already approved plan.
    'uv.lock',
    'poetry.lock',
    'Pipfile.lock',
    'go.mod',
    'go.sum',
    'go.work',
    'go.work.sum',
    'Cargo.toml',
    'Cargo.lock',
    '.cargo/config.toml',
    '.cargo/config',
    'rust-toolchain.toml',
    'rust-toolchain',
    ...(ecosystem === 'uv'
      ? [
          'pyproject.toml',
          'uv.toml',
          '.python-version',
          '.python-versions',
          ...globSync(['**/pyproject.toml', '**/uv.toml', '**/.python-version'], {
            cwd: root,
            exclude: [
              '**/.venv/**',
              '**/venv/**',
              '**/node_modules/**',
              '**/.git/**',
              '**/.tmp/**',
            ],
          }),
        ]
      : []),
    ...(ecosystem === 'go' ? [...goManifests, ...goSources] : []),
    ...(ecosystem === 'cargo' ? cargoManifests : []),
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
  const uvArgs = ['sync', '--locked', '--all-packages', '--no-python-downloads']
  const uvChecks: PreparationCheck[] =
    ecosystem === 'uv'
      ? [
          {
            name: 'uv',
            command: { command: 'uv', args: ['--version'] },
            outputIncludes: 'uv ',
            fingerprintOutput: true,
          },
          {
            name: 'Compatible Python',
            command: {
              command: 'uv',
              args: ['python', 'find', '--offline', '--no-cache', '--no-python-downloads'],
            },
            fingerprintOutput: true,
          },
          {
            name: 'Python environment',
            path: '.venv/bin/python',
            command: {
              command: '.venv/bin/python',
              args: [
                '-I',
                '-c',
                'import sys; print(sys.version); print(sys.implementation.cache_tag); print(sys.base_prefix)',
              ],
            },
            fingerprintOutput: true,
          },
          {
            name: 'Locked Python dependencies',
            command: { command: 'uv', args: [...uvArgs, '--check', '--offline', '--no-cache'] },
            fingerprintOutput: false,
          },
        ]
      : []
  const goListArgs = ['list', '-mod=readonly', '-deps', '-test', 'all']
  const goChecks: PreparationCheck[] =
    ecosystem === 'go'
      ? [
          {
            name: 'Go toolchain',
            command: { command: 'go', args: ['version'] },
            outputIncludes: 'go version go',
            fingerprintOutput: true,
          },
          {
            name: 'Readonly Go package graph',
            command: { command: 'go', args: goListArgs },
            fingerprintOutput: false,
          },
          {
            name: 'Verified Go module cache',
            command: { command: 'go', args: ['mod', 'verify'] },
            outputIncludes: 'all modules verified',
            fingerprintOutput: false,
          },
        ]
      : []
  const cargoFetchArgs = [
    'fetch',
    '--locked',
    '--manifest-path',
    'Cargo.toml',
    '--config',
    'net.git-fetch-with-cli=false',
  ]
  const cargoChecks: PreparationCheck[] =
    ecosystem === 'cargo'
      ? [
          {
            name: 'Cargo',
            command: { command: 'cargo', args: ['--version'] },
            outputIncludes: 'cargo ',
            fingerprintOutput: true,
          },
          {
            name: 'Rust toolchain',
            command: { command: 'rustc', args: ['-vV'] },
            outputIncludes: 'rustc ',
            fingerprintOutput: true,
          },
          {
            name: 'Locked Cargo dependencies',
            command: { command: 'cargo', args: [...cargoFetchArgs, '--offline'] },
            fingerprintOutput: false,
          },
        ]
      : []
  return {
    root,
    fingerprint,
    ecosystem,
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
    prepare:
      ecosystem === 'uv'
        ? [{ command: 'uv', args: uvArgs }]
        : ecosystem === 'go'
          ? [{ command: 'go', args: goListArgs }]
          : ecosystem === 'cargo'
            ? [{ command: 'cargo', args: cargoFetchArgs }]
            : (config?.prepare ?? []),
    checks:
      ecosystem === 'uv'
        ? uvChecks
        : ecosystem === 'go'
          ? goChecks
          : ecosystem === 'cargo'
            ? cargoChecks
            : (config?.checks ?? []),
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
    `Package manager: ${plan.manager ? `${plan.manager.name}${plan.manager.version ? `@${plan.manager.version}` : ' (version detected locally)'}` : plan.ecosystem === 'uv' ? 'uv (Python)' : plan.ecosystem === 'go' ? 'Go modules' : plan.ecosystem === 'cargo' ? 'Cargo (Rust)' : 'project-defined setup'}`,
    ...(install
      ? [
          `Install through Socket Firewall: ${JSON.stringify([install.command, ...install.args])} (dependency lifecycle scripts disabled)`,
        ]
      : []),
    ...plan.prepare.map((step) =>
      plan.ecosystem === 'go'
        ? `Readonly package metadata load: ${JSON.stringify([step.command, ...step.args])}`
        : plan.ecosystem === 'cargo'
          ? `Fetch locked Cargo dependencies: ${JSON.stringify([step.command, ...step.args])}`
          : `Project setup (executes repository code): ${JSON.stringify([step.command, ...step.args])}`,
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
              plan.ecosystem === 'go'
                ? 'Load locked Go package metadata:'
                : plan.ecosystem === 'cargo'
                  ? 'Fetch locked Cargo dependencies:'
                  : 'Project setup:',
              ...plan.prepare.map((step) => formatArgvForShell(step.command, step.args)),
            ]
          : []),
      ].join('\n') || 'No setup commands; validate the declared checks.',
    bodyAdvice: [
      ...(install ? ['Install locked dependencies with lifecycle scripts disabled.'] : []),
      ...(plan.ecosystem === 'go'
        ? [
            'Loads package and test import metadata to populate the locked module cache; it does not run go generate, build, or test.',
          ]
        : plan.ecosystem === 'cargo'
          ? [
              'Fetches the locked dependency sources only; it does not compile crates or run build scripts, tests, or binaries.',
            ]
          : plan.prepare.length
            ? ['Project setup executes repository code.']
            : []),
    ].join(' '),
    bodyFooter: `Network: ${offline ? 'blocked for every subprocess' : 'allowed during preparation; checks stay offline'}. ${plan.ecosystem === 'go' || plan.ecosystem === 'cargo' ? 'The project remains read-only; writes use disposable scratch and Copse-managed caches.' : 'Writes are limited to this project and Copse-managed caches.'}\nProject: ${plan.root}`,
  }
}
