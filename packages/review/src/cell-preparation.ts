// The trusted host's half of preparing a review cell: fill the read-only
// dependency cache the cell installs from, and build the image it runs in.
//
// Shared by the GitHub Actions shell (`ci/prepare-action.mts`) and the local
// pull-request shell (`local-pr.ts`), so the two cannot drift on what the host
// fetches. Nothing from the change under review executes here: lockfiles and
// patch blobs are read as data from git, `pnpm fetch` / `npm cache add` run in
// a caller-owned seed directory with no manifest, `.npmrc`, pnpmfile or script
// from the repository, and every install happens later inside the cell.
//
// The cache must hold the packages of the cell's platform, not the host's.
// On a Linux runner the two match. On a Mac the cell is Linux on the same CPU,
// and pnpm would otherwise fetch the darwin builds of every platform package
// (esbuild, rollup, …), leaving the offline install in the cell with nothing to
// link. `supportedArchitectures` in the seed's workspace file makes `pnpm
// fetch` resolve for the cell. npm lockfiles already list every platform's
// optional package, so `npm cache add` needs no equivalent.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { memberOf } from '@copse/std/member-of.ts'
import type { ContainerDialect } from './container-backend.ts'
import { npmTarballs, pnpmLockPatches } from './dependency-policy.ts'

/**
 * How the host fills the cache and the cell installs from it. `npm` and
 * `pnpm` are the portable profiles; `copse-pnpm` is Copse's own repository,
 * whose lockfile carries one reviewed directory dependency and whose
 * preparation script also builds node-pty inside the cell.
 */
export const PREPARATION_PROFILES = ['npm', 'pnpm', 'copse-pnpm'] as const
export type PreparationProfile = (typeof PREPARATION_PROFILES)[number]
export const isPreparationProfile = memberOf(PREPARATION_PROFILES)

/** The CPU of the cell's Linux, in pnpm's (and Node's) spelling. */
export const CELL_CPUS = ['arm64', 'x64'] as const
export type CellCpu = (typeof CELL_CPUS)[number]
export const isCellCpu = memberOf(CELL_CPUS)

/** The cell's platform. The image is Debian, so the libc is always glibc. */
export interface CellPlatform {
  readonly os: 'linux'
  readonly cpu: CellCpu
  readonly libc: 'glibc'
}

/** A Linux cell on `cpu`, by default this host's CPU (`process.arch`). */
export function cellPlatform(cpu: string = process.arch): CellPlatform {
  if (!isCellCpu(cpu)) {
    throw new Error(`A review cell runs on arm64 or x64 Linux; this host is ${cpu}`)
  }
  return { os: 'linux', cpu, libc: 'glibc' }
}

/** The OCI architecture name engines take for a cell CPU. */
export function imageArchitecture(cpu: CellCpu): 'arm64' | 'amd64' {
  return cpu === 'x64' ? 'amd64' : 'arm64'
}

/** Runs one host command to completion with inherited stdio; throws when it fails. */
export type HostCommandRunner = (
  file: string,
  args: readonly string[],
  options: {
    readonly cwd: string
    /** Variables set over the caller's own environment for this command. */
    readonly env?: Readonly<Record<string, string>> | undefined
  },
) => void

export interface PrimeDependencyCacheInput {
  readonly profile: PreparationProfile
  /** The commits whose lockfiles are fetched: the merge-base and the head. */
  readonly revisions: readonly string[]
  /** One file at a revision, as git stores it (`git show <rev>:<path>`). */
  readonly show: (revision: string, path: string) => string
  /** Caller-owned scratch the fetch runs in. Its contents are replaced. */
  readonly seed: string
  /** The cache: npm's `_cacache` parent, or pnpm's store directory. */
  readonly cache: string
  readonly platform: CellPlatform
  readonly run: HostCommandRunner
  /**
   * The `packageManager` the seed declares (`pnpm@10.34.5`), so Corepack runs
   * the same pnpm the reviewer pins rather than whatever is newest. Unset leaves
   * the version to the caller's environment, as the Actions shell activates it.
   */
  readonly packageManager?: string | undefined
}

/** The seed's `pnpm-workspace.yaml`: no packages, the lockfile's patches, the cell's platform. */
export function pnpmSeedWorkspace(
  patches: Readonly<Record<string, string>>,
  platform: CellPlatform,
): string {
  // JSON is YAML; nothing here comes from the repository but validated patch paths.
  return JSON.stringify({
    packages: [],
    patchedDependencies: patches,
    supportedArchitectures: {
      os: [platform.os],
      cpu: [platform.cpu],
      libc: [platform.libc],
    },
  })
}

/** Fill `cache` with what the cell needs to install every revision offline. */
export async function primeDependencyCache(input: PrimeDependencyCacheInput): Promise<void> {
  await mkdir(input.seed, { recursive: true })
  if (input.profile === 'npm') {
    await mkdir(join(input.cache, '_cacache'), { recursive: true })
    const urls = new Set<string>()
    for (const revision of input.revisions) {
      for (const url of npmTarballs(input.show(revision, 'package-lock.json'))) urls.add(url)
    }
    // The working directory holds only this caller-owned empty config; npm
    // never sees `.npmrc`, `package.json`, workspace declarations or scripts
    // from the change.
    const npmrc = join(input.seed, 'empty.npmrc')
    const globalNpmrc = join(input.seed, 'global.npmrc')
    await writeFile(npmrc, '')
    await writeFile(globalNpmrc, '')
    for (const url of urls) {
      input.run(
        'npm',
        [
          'cache',
          'add',
          url,
          '--cache',
          input.cache,
          '--ignore-scripts',
          '--userconfig',
          npmrc,
          '--globalconfig',
          globalNpmrc,
        ],
        { cwd: input.seed },
      )
    }
    return
  }
  await mkdir(input.cache, { recursive: true })
  const directories = input.profile === 'copse-pnpm' ? 'copse' : 'relative'
  // As for npm: the caller's own config (scoped registries, their tokens)
  // never reaches the fetch, which takes only the pinned public registry.
  // `pnpm fetch` refuses `--userconfig` and `--globalconfig` as unknown
  // options, so the empty files arrive as npm's environment variables, and
  // XDG_CONFIG_HOME moves pnpm's own global rc (~/.config/pnpm/rc, or
  // ~/Library/Preferences/pnpm/rc on a Mac) to an empty directory. Both
  // spellings: the runner sets these over the caller's environment, and the
  // pinned pnpm reads a caller's NPM_CONFIG_USERCONFIG ahead of the
  // lower-case name.
  const userconfig = join(input.seed, 'empty.npmrc')
  const configHome = join(input.seed, 'empty-config')
  await mkdir(configHome, { recursive: true })
  await writeFile(userconfig, '')
  const callerConfigOut = {
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: userconfig,
    NPM_CONFIG_USERCONFIG: userconfig,
    NPM_CONFIG_GLOBALCONFIG: userconfig,
    XDG_CONFIG_HOME: configHome,
  }
  for (const revision of input.revisions) {
    // pnpm fetch reads only these validated lockfiles and patch blobs. It skips
    // local directory dependencies; their contents are installed only inside
    // the cell. A fresh seed per revision: pnpm asks before purging a virtual
    // store it finds, and nothing of one revision's fetch belongs to the next.
    await rm(join(input.seed, 'node_modules'), { recursive: true, force: true })
    const lock = input.show(revision, 'pnpm-lock.yaml')
    const patches = pnpmLockPatches(lock, directories)
    for (const patch of Object.values(patches)) {
      const target = join(input.seed, patch)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, input.show(revision, patch))
    }
    await writeFile(join(input.seed, 'pnpm-lock.yaml'), lock.endsWith('\n') ? lock : `${lock}\n`)
    await writeFile(
      join(input.seed, 'pnpm-workspace.yaml'),
      pnpmSeedWorkspace(patches, input.platform),
    )
    if (input.packageManager !== undefined) {
      await writeFile(
        join(input.seed, 'package.json'),
        `${JSON.stringify({ private: true, packageManager: input.packageManager })}\n`,
      )
    }
    input.run(
      'pnpm',
      [
        'fetch',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--ignore-pnpmfile',
        '--dir',
        input.seed,
        '--store-dir',
        input.cache,
        '--registry',
        'https://registry.npmjs.org',
      ],
      { cwd: input.seed, env: callerConfigOut },
    )
  }
}

/**
 * The reviewer checkout this package runs from (the Copse repository root).
 * A function, so a bundle that never prepares a cell never resolves it.
 */
export function reviewerRoot(): string {
  return resolve(import.meta.dirname, '../../..')
}

/** The validation image's Dockerfile; it copies nothing from its context. */
export function cellDockerfile(): string {
  return join(reviewerRoot(), 'packages/review/Dockerfile.cell')
}

/**
 * The trusted preparation script for a profile, from the reviewer's checkout
 * rather than the change's: one reviewed policy across old and new heads. The
 * portable pnpm profile has none; the checkout's own `prepare` runs (in the cell).
 */
export function trustedPreparationScript(profile: PreparationProfile): string | null {
  switch (profile) {
    case 'npm':
      return join(reviewerRoot(), 'packages/review/ci/prepare-npm-checkout.mts')
    case 'copse-pnpm':
      return join(reviewerRoot(), 'scripts/prepare-review-stage0.mts')
    case 'pnpm':
      return null
  }
}

export interface CellImageBuild {
  readonly dialect: ContainerDialect
  readonly dockerfile: string
  readonly tag: string
  /** The build context; the cell's Dockerfile copies nothing from it. */
  readonly context: string
  /** Build for this CPU instead of the engine's default. */
  readonly cpu?: CellCpu | undefined
  /** A CA bundle for a TLS-intercepting proxy, as a build secret (Docker only). */
  readonly proxyCaFile?: string | undefined
}

/** The `build` argv (after the engine's own argv) for the validation image. */
export function cellImageBuildArgs(build: CellImageBuild): string[] {
  const args = ['build']
  if (build.proxyCaFile !== undefined) {
    if (build.dialect === 'apple') {
      throw new Error('Apple container builds take no file secret; build behind no proxy CA')
    }
    args.push('--secret', `id=proxy_ca,src=${build.proxyCaFile}`)
  }
  args.push('--file', build.dockerfile, '--tag', build.tag)
  if (build.cpu !== undefined) {
    const architecture = imageArchitecture(build.cpu)
    if (build.dialect === 'apple') args.push('--arch', architecture)
    else args.push('--platform', `linux/${architecture}`)
  }
  args.push(build.context)
  return args
}
