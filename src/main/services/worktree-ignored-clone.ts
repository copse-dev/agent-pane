import { constants } from 'node:fs'
import { cp, lstat, mkdir, readlink, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Git-ignored content (installed dependencies, build output, local config) is
 * what makes a fresh worktree expensive: it is not in the commit, so every new
 * checkout would otherwise reinstall or rebuild it. A copy-on-write clone
 * (`clonefile` on APFS, `FICLONE` on btrfs/XFS) hands the new checkout the same
 * bytes without duplicating them.
 *
 * Cloning is strictly best-effort. It runs only where the filesystem can
 * reflink, never falls back to a byte copy, and never fails the allocation; a
 * worktree that gets nothing simply starts as clean as it did before.
 */

const NEVER_CLONE_SEGMENTS: ReadonlySet<string> = new Set([
  '.git',
  '.worktrees',
  '.aws',
  '.ssh',
  '.gnupg',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'secrets',
  'credentials',
  'credentials.json',
])

const SECRET_LIKE_NAME =
  /^\.env(\..*)?$|^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$|\.(pem|key|p12|pfx|jks|keystore)$/i

/** Whether any segment of a repository-relative path names likely secret material. */
export function isSecretLikePath(path: string): boolean {
  return path
    .split('/')
    .filter(Boolean)
    .some((segment) => NEVER_CLONE_SEGMENTS.has(segment) || SECRET_LIKE_NAME.test(segment))
}

/**
 * Entries to clone from `git ls-files --others --ignored --exclude-standard
 * --directory -z`. A wholly-ignored directory arrives as one `dir/` entry, so a
 * `node_modules` of hundreds of thousands of files is a single clone. Entries
 * are dropped when they could escape the checkout or look like secrets.
 */
export function selectIgnoredCloneEntries(listing: string): string[] {
  const entries: string[] = []
  for (const raw of listing.split('\0')) {
    const entry = raw.endsWith('/') ? raw.slice(0, -1) : raw
    if (!entry || isAbsolute(entry) || entry.split('/').includes('..')) continue
    if (isSecretLikePath(entry)) continue
    entries.push(entry)
  }
  return entries
}

const UNSUPPORTED_CLONE_CODES: ReadonlySet<string> = new Set([
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
  'EXDEV',
  'EINVAL',
])

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

export interface IgnoredCloneResult {
  cloned: string[]
  /** The filesystem (or volume pairing) cannot reflink; nothing further was attempted. */
  unsupported: boolean
}

/**
 * Reflink ignored entries from the project checkout into a new worktree.
 * Symlinks are kept only when relative and still inside the project (pnpm's
 * `node_modules` graph); an absolute or escaping link would let the worktree
 * reach back into the user's checkout, so it is left out.
 */
export async function cloneIgnoredEntries(input: {
  projectRoot: string
  worktreeRoot: string
  listing: string
}): Promise<IgnoredCloneResult> {
  const { projectRoot, worktreeRoot } = input
  const result: IgnoredCloneResult = { cloned: [], unsupported: false }
  const keep = async (source: string): Promise<boolean> => {
    const stat = await lstat(source)
    if (stat.isSymbolicLink()) {
      const target = await readlink(source)
      return !isAbsolute(target) && isWithin(projectRoot, resolve(dirname(source), target))
    }
    return stat.isFile() || stat.isDirectory()
  }

  for (const entry of selectIgnoredCloneEntries(input.listing)) {
    const source = join(projectRoot, entry)
    const destination = join(worktreeRoot, entry)
    try {
      if (!(await keep(source)) || (await exists(destination))) continue
      await mkdir(dirname(destination), { recursive: true })
      await cp(source, destination, {
        recursive: true,
        mode: constants.COPYFILE_FICLONE_FORCE,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
        filter: keep,
      })
      result.cloned.push(entry)
    } catch (error) {
      // A partial clone is worse than none: drop whatever landed, then either
      // stop (the filesystem can't do this) or move on to the next entry.
      await rm(destination, { recursive: true, force: true }).catch(() => undefined)
      const code = errorCode(error)
      if (code !== undefined && UNSUPPORTED_CLONE_CODES.has(code)) {
        result.unsupported = true
        break
      }
      if (code !== 'ENOENT') {
        console.warn(`[worktree] Could not clone ignored entry ${entry}: ${String(error)}`)
      }
    }
  }
  return result
}
