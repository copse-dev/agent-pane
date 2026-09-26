/**
 * Checkout-relative names ASRT denies writes to in every workspace (mirroring
 * its macOS mandatory write denies). Kept free of imports so tooling outside
 * the app, such as the e2e fixture helpers, can share the list.
 */
export const DANGEROUS_CONFIG_FILENAMES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
] as const

export const DANGEROUS_CONFIG_DIR_NAMES = [
  '.vscode',
  '.idea',
  '.claude/commands',
  '.claude/agents',
  '.cursor/agents',
  '.copse/agents',
] as const

/**
 * Whether a checkout-relative path is one Linux bwrap can materialize for the
 * mandatory write denies above: a deny target itself, or a directory created
 * only to hold one (`.claude` for `.claude/agents`).
 *
 * bwrap cannot bind over a missing path, so every sandboxed command creates an
 * empty file or directory at each absent deny target in the real checkout while
 * it runs. Another process reading the checkout meanwhile sees those as
 * untracked files. A path match alone is not proof; callers must also check
 * that the entry is empty.
 */
export function isMandatoryWriteDenyMountPath(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean)
  const last = segments.at(-1)
  if (last === undefined) return false
  if (DANGEROUS_CONFIG_FILENAMES.some((fileName) => fileName === last)) return true
  return DANGEROUS_CONFIG_DIR_NAMES.some((dirName) => {
    const target = dirName.split('/')
    // A proper prefix of the target is its materialized parent directory.
    for (let length = 1; length <= target.length; length += 1) {
      const tail = segments.slice(-length)
      if (tail.length === length && tail.every((segment, index) => segment === target[index])) {
        return true
      }
    }
    return false
  })
}
