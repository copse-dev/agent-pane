import { redactSecrets } from '@copse/llm/redact-secrets.ts'
import { secretFileName } from '@copse/shell-guard/secrets.ts'
import { internalGit, internalGitRaw } from './internal-git-exec.ts'

/**
 * What a network-scoped `git push` would publish, checked before the push may
 * skip its prompt.
 *
 * Scoping limits a push to its recorded remote, but the remote may be public,
 * and a contained command can commit a `.env` or a key first. So the outgoing
 * commits — everything reachable from HEAD or a local branch that no
 * remote-tracking ref of the push's remotes already has — are checked for
 * secret files by name (the same list the read tier refuses) and for
 * high-confidence token shapes in added lines (`redactSecrets`, the patterns
 * used before text leaves for a provider). Any match, or history too large to
 * check, makes the push ask.
 *
 * Over-counting on purpose: other unpushed local branches are included, since
 * reading the exact refspec git would use costs more than an occasional prompt.
 * Git runs through `internalGit`, whose overrides keep the checkout's config
 * from choosing a program, and with `--no-ext-diff --no-textconv`.
 */

const MAX_OUTGOING_COMMITS = 500
const MAX_PATCH_BYTES = 16 * 1024 * 1024

/** Why the outgoing commits must not be published unasked, or null when none applies. */
export async function outgoingPushSecretReason(
  root: string,
  remotes: readonly string[],
): Promise<string | null> {
  const range = ['HEAD', '--branches', '--not', ...remotes.map((remote) => `--remotes=${remote}`)]
  try {
    const count = Number(await internalGit(root, ['rev-list', '--count', ...range]))
    if (!Number.isFinite(count)) return 'could not count the outgoing commits'
    if (count === 0) return null
    if (count > MAX_OUTGOING_COMMITS) {
      return `${String(count)} outgoing commits are too many to check for secrets`
    }
    const names = await internalGit(root, [
      'log',
      '--name-only',
      '--no-renames',
      '--format=',
      ...range,
    ])
    for (const path of names.split('\n')) {
      const secret = path ? secretFileName(path) : null
      if (secret) return `the push would publish a secret file: ${path}`
    }
    const patch = await internalGitRaw(
      root,
      ['log', '-p', '--no-color', '--no-renames', '--format=', ...range],
      { maxBuffer: MAX_PATCH_BYTES },
    )
    const added = patch
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .join('\n')
    if (redactSecrets(added) !== added) return 'the push would publish a token-shaped secret'
    return null
  } catch {
    return 'could not read the outgoing commits'
  }
}
