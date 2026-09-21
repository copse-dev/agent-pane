// Stage 0 has to know what "build", "typecheck", "lint" and "test" mean in
// the repository under review. Binding decision B5: TypeScript with pnpm is
// the only ecosystem detected for now. A repo can override or disable any
// command with a `review.config.json` at its root (§Configuration); that file
// is repo-controlled, so its argv only ever runs INSIDE the cell — the
// orchestrator reads it as data and never evaluates it.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { memberOf } from '@copse/std/member-of.ts'

/** In run order. `prepare` installs dependencies; the rest are the checks. */
export const CHECK_KINDS = ['prepare', 'build', 'typecheck', 'lint', 'test'] as const
export type CheckKind = (typeof CHECK_KINDS)[number]
export const isCheckKind = memberOf(CHECK_KINDS)

export const REVIEW_CONFIG_FILENAME = 'review.config.json'

export interface CheckCommand {
  readonly kind: CheckKind
  readonly argv: readonly [string, ...string[]]
  readonly timeoutMs: number
}

export interface ProjectCommands {
  readonly ecosystem: 'typescript-pnpm' | 'configured'
  /** Where the commands came from, for the report. */
  readonly source: 'package.json' | typeof REVIEW_CONFIG_FILENAME
  readonly commands: readonly CheckCommand[]
}

export interface UnsupportedProject {
  readonly ecosystem: 'unsupported'
  readonly reason: string
}

export const DEFAULT_CHECK_TIMEOUT_MS = 20 * 60 * 1000
export const DEFAULT_PREPARE_TIMEOUT_MS = 10 * 60 * 1000

/**
 * The default install. `--offline` because the cell has no network (a
 * registry allowlist is P1's open question); `--frozen-lockfile` because a
 * review must not rewrite the lockfile; `--ignore-scripts` because a
 * repo-controlled `postinstall` running with the orchestrator in scope is the
 * CodeRabbit incident, and a native module that needs its build step is a
 * config decision the repo makes explicitly, not one the reviewer makes for it.
 */
export const DEFAULT_PNPM_PREPARE: readonly [string, ...string[]] = [
  'pnpm',
  'install',
  '--frozen-lockfile',
  '--offline',
  '--ignore-scripts',
]

const argvSchema = z.array(z.string().min(1)).min(1)

/**
 * `review.config.json`. Each command is an argv (never a shell string: nothing
 * in this pipeline goes through a shell). `null` disables a check the
 * detector would otherwise run. Timeouts are per check kind, in milliseconds.
 */
export const reviewConfigSchema = z.object({
  commands: z
    .object({
      prepare: argvSchema.nullable().optional(),
      build: argvSchema.nullable().optional(),
      typecheck: argvSchema.nullable().optional(),
      lint: argvSchema.nullable().optional(),
      test: argvSchema.nullable().optional(),
    })
    .optional(),
  timeoutsMs: z
    .object({
      prepare: z.number().int().positive().optional(),
      build: z.number().int().positive().optional(),
      typecheck: z.number().int().positive().optional(),
      lint: z.number().int().positive().optional(),
      test: z.number().int().positive().optional(),
    })
    .optional(),
})
export type ReviewConfig = z.infer<typeof reviewConfigSchema>
const decodeReviewConfig = decodeWithSchema(reviewConfigSchema)

const packageManifestSchema = z.object({
  packageManager: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
})
const decodePackageManifest = decodeWithSchema(packageManifestSchema)

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function argvOf(list: readonly string[]): readonly [string, ...string[]] | null {
  const [first, ...rest] = list
  return first === undefined ? null : [first, ...rest]
}

function timeoutFor(kind: CheckKind, config: ReviewConfig | null): number {
  const configured = config?.timeoutsMs?.[kind]
  if (configured !== undefined) return configured
  return kind === 'prepare' ? DEFAULT_PREPARE_TIMEOUT_MS : DEFAULT_CHECK_TIMEOUT_MS
}

/**
 * Detect the commands for one checkout. Detection is per checkout because base
 * and head may declare different scripts; the delta pairs the results by kind.
 */
export async function detectProjectCommands(
  checkoutRoot: string,
): Promise<ProjectCommands | UnsupportedProject> {
  const configText = await readOptional(join(checkoutRoot, REVIEW_CONFIG_FILENAME))
  let config: ReviewConfig | null = null
  if (configText !== null) {
    config = safeJsonParse(configText, decodeReviewConfig)
    if (config === null) {
      return { ecosystem: 'unsupported', reason: `${REVIEW_CONFIG_FILENAME} is not valid` }
    }
  }

  const manifestText = await readOptional(join(checkoutRoot, 'package.json'))
  const manifest = manifestText === null ? null : safeJsonParse(manifestText, decodePackageManifest)
  const lockfile = await readOptional(join(checkoutRoot, 'pnpm-lock.yaml'))
  const usesPnpm = lockfile !== null || (manifest?.packageManager?.startsWith('pnpm@') ?? false)
  const tsconfig = await readOptional(join(checkoutRoot, 'tsconfig.json'))
  const usesTypeScript =
    tsconfig !== null ||
    Object.hasOwn(manifest?.devDependencies ?? {}, 'typescript') ||
    Object.hasOwn(manifest?.dependencies ?? {}, 'typescript')

  const detected: Partial<Record<CheckKind, readonly [string, ...string[]]>> = {}
  if (manifest !== null && usesPnpm && usesTypeScript) {
    detected.prepare = DEFAULT_PNPM_PREPARE
    for (const kind of CHECK_KINDS) {
      if (kind === 'prepare') continue
      if (manifest.scripts !== undefined && Object.hasOwn(manifest.scripts, kind)) {
        detected[kind] = ['pnpm', 'run', kind]
      }
    }
  }

  const commands: CheckCommand[] = []
  for (const kind of CHECK_KINDS) {
    const configured = config?.commands?.[kind]
    if (configured === null) continue
    const argv = configured === undefined ? detected[kind] : argvOf(configured)
    if (argv === undefined || argv === null) continue
    commands.push({ kind, argv, timeoutMs: timeoutFor(kind, config) })
  }

  if (commands.some((command) => command.kind !== 'prepare')) {
    return {
      ecosystem: config?.commands !== undefined ? 'configured' : 'typescript-pnpm',
      source: config !== null ? REVIEW_CONFIG_FILENAME : 'package.json',
      commands,
    }
  }
  if (manifest === null) {
    return { ecosystem: 'unsupported', reason: 'no package.json at the checkout root' }
  }
  if (!usesPnpm) {
    return {
      ecosystem: 'unsupported',
      reason:
        'not a pnpm project (no pnpm-lock.yaml or pnpm packageManager); TypeScript with pnpm is the only detected ecosystem (B5)',
    }
  }
  if (!usesTypeScript) {
    return { ecosystem: 'unsupported', reason: 'no tsconfig.json or typescript dependency (B5)' }
  }
  return {
    ecosystem: 'unsupported',
    reason: 'package.json declares none of the build, typecheck, lint or test scripts',
  }
}
