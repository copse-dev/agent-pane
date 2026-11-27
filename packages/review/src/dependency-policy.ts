// What the trusted host may fetch for a review, read from a lockfile as data.
//
// Stage 0 installs dependencies inside a network-disabled cell, so the host
// fills a read-only dependency cache first. It reads only the lockfiles of the
// two revisions under review: never a contributor manifest, `.npmrc`, install
// script or pnpmfile. These checks decide which lockfile entries the host will
// fetch, and refuse a lockfile that would make it fetch anything but registry
// packages. The GitHub Actions shell (`ci/prepare-action.mts`) and the local
// pull-request shell (`local-pr.ts`) share them.
import { z } from 'zod'
import { load as loadYaml } from 'js-yaml'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'

const npmLockSchema = z.object({
  lockfileVersion: z.union([z.literal(2), z.literal(3)]),
  packages: z.record(
    z.string(),
    z.object({
      resolved: z.string().optional(),
      integrity: z.string().optional(),
      link: z.boolean().optional(),
    }),
  ),
})

/** Only registry tarballs are fetched on the trusted host, never a contributor manifest. */
export function npmTarballs(text: string): string[] {
  const lock = safeJsonParse(text, decodeWithSchema(npmLockSchema))
  if (lock === null) throw new Error('Copse Reviewer requires an npm v2/v3 package-lock.json')
  const urls = new Set<string>()
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '') continue
    if (
      !path.startsWith('node_modules/') ||
      entry.link ||
      !entry.resolved ||
      !entry.integrity?.match(/^sha512-[A-Za-z0-9+/]+=*$/)
    ) {
      throw new Error(
        'Copse Reviewer requires integrity-pinned registry dependencies; links are unsupported',
      )
    }
    const url = new URL(entry.resolved)
    if (
      url.origin !== 'https://registry.npmjs.org' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      !url.pathname.endsWith('.tgz')
    ) {
      throw new Error('Copse Reviewer only fetches HTTPS tarballs from registry.npmjs.org')
    }
    urls.add(url.href)
  }
  return [...urls]
}

const registryIntegrity = z
  .object({ integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+=*$/) })
  .strict()
const directoryResolution = z
  .object({ directory: z.string().min(1), type: z.literal('directory') })
  .strict()

const pnpmLockSchema = z.object({
  lockfileVersion: z.literal('9.0'),
  packages: z
    .record(z.string(), z.object({ resolution: z.union([registryIntegrity, directoryResolution]) }))
    .optional(),
  patchedDependencies: z
    .record(
      z.string(),
      z.object({
        hash: z.string().regex(/^[0-9a-f]{64}$/),
        path: z.string().regex(/^patches\/[^/]+\.patch$/),
      }),
    )
    .optional(),
})

/**
 * Which `directory` resolutions a pnpm lockfile may carry. `pnpm fetch` skips
 * them on the host; their contents come from the checkout and are installed
 * only inside the cell. `copse` is the one reviewed directory dependency of
 * Copse's own lockfile; `relative` admits any path inside the repository.
 */
export type PnpmDirectoryPolicy = 'copse' | 'relative'

const COPSE_DIRECTORY_DEPENDENCY = 'extract-zip@file:packages/extract-zip'

function isRelativeInsideRepository(path: string): boolean {
  if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) return false
  return path.split('/').every((part) => part !== '..' && part.length > 0)
}

/**
 * Validate a pnpm lockfile and return its patched dependencies (name → patch
 * path). Every package must be an integrity-pinned registry version, or a
 * directory the policy admits; patch files must live under `patches/`.
 */
export function pnpmLockPatches(
  text: string,
  directories: PnpmDirectoryPolicy,
): Record<string, string> {
  const lock = pnpmLockSchema.parse(loadYaml(text))
  for (const [name, entry] of Object.entries(lock.packages ?? {})) {
    if (Object.hasOwn(entry.resolution, 'directory')) {
      const directory = directoryResolution.parse(entry.resolution).directory
      const admitted =
        directories === 'copse'
          ? name === COPSE_DIRECTORY_DEPENDENCY && directory === 'packages/extract-zip'
          : isRelativeInsideRepository(directory)
      if (!admitted) {
        throw new Error(
          directories === 'copse'
            ? 'Only the reviewed Copse extract-zip directory dependency is supported'
            : `Directory dependency ${name} must stay inside the repository`,
        )
      }
    } else if (!/^(?:@[^/\s]+\/)?[^@/:\s]+@[^/:\s]+$/.test(name)) {
      throw new Error('Copse Reviewer requires registry package versions')
    }
  }
  return Object.fromEntries(
    Object.entries(lock.patchedDependencies ?? {}).map(([name, patch]) => [name, patch.path]),
  )
}

/** Copse's one reviewed directory dependency stays in the cell; the host only fetches registry data. */
export function copsePnpmPatches(text: string): Record<string, string> {
  return pnpmLockPatches(text, 'copse')
}
