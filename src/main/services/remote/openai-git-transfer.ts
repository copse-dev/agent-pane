export { prepareGitTransfer } from './openai-git-snapshot.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import {
  createSnapshotCommit,
  fetchCarryOut,
  adoptCarryOut,
} from '../container-runtime/thread-container.ts'

const exec = promisify(execFile)
const sha = z.string().regex(/^[a-f0-9]{40,64}$/)
export const gitTransferSchema = z.object({
  id: z.uuid(),
  root: z.string(),
  base: sha,
  tree: sha,
  sourceHead: sha,
  branch: z.string(),
  ref: z.string().regex(/^refs\/copse\/carry-in\/[a-f0-9-]+$/),
  imported: z.boolean().default(false),
})
export type GitTransfer = z.infer<typeof gitTransferSchema>
export const gitResultSchema = z.object({ base: sha, head: sha, changed: z.boolean() })
const git = async (root: string, args: string[]): Promise<string> =>
  (
    await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout.trim()

/** Validate the expected base and guest ref before using the existing container adoption path. */
export async function importGitTransfer(
  transfer: GitTransfer,
  root: string,
  directory: string,
): Promise<void> {
  if ((await realpath(root)) !== transfer.root)
    throw new Error('The thread checkout changed; its hosted result was retained.')
  if (transfer.imported) return
  const currentBranch = await git(root, ['branch', '--show-current'])
  if (currentBranch !== transfer.branch && currentBranch !== `copse/openai-${transfer.id}`)
    throw new Error('The checkout branch changed; switch back before importing the hosted result.')
  const result = safeJsonParse(
    await readFile(join(directory, 'copse-result.json'), 'utf8'),
    decodeWithSchema(gitResultSchema),
  )
  if (!result || result.base !== transfer.base)
    throw new Error('Hosted result has the wrong snapshot base.')
  if (!result.changed) {
    if (result.head !== transfer.base) throw new Error('Invalid unchanged hosted result.')
    transfer.imported = true
    return
  }
  const bundle = join(directory, 'copse.bundle')
  if ((await stat(bundle)).size > 200 * 1024 * 1024)
    throw new Error('Hosted Git bundle exceeds 200 MiB.')
  await git(root, ['bundle', 'verify', bundle])
  const heads = await git(root, ['bundle', 'list-heads', bundle])
  if (heads !== `${result.head} refs/heads/work`)
    throw new Error('Unexpected hosted Git bundle refs.')
  const ref = await fetchCarryOut(root, `openai-${transfer.id}`, bundle)
  await git(root, ['merge-base', '--is-ancestor', transfer.base, ref])
  if (await git(root, ['rev-list', '--merges', `${transfer.base}..${ref}`]))
    throw new Error('Hosted merge commits cannot be adopted automatically.')
  // A retry after successful cherry-pick is safe even if saving the checkpoint failed.
  const added = (
    await git(root, ['diff', '--name-only', '-z', '--diff-filter=A', transfer.base, ref])
  )
    .split('\0')
    .filter(Boolean)
  if (
    added.length > 0 &&
    (await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--', ...added]))
  )
    throw new Error(
      'Hosted changes would replace ignored local files; the returned commits are retained.',
    )
  const cherry = await git(root, ['cherry', 'HEAD', ref, transfer.base])
  if (cherry.split('\n').some((line) => line.startsWith('+ '))) {
    const current = await createSnapshotCommit(root)
    if (current.dirty || (await git(root, ['rev-parse', 'HEAD^{tree}'])) !== transfer.tree)
      throw new Error(
        'Local files changed. Commit the original snapshot before retrying; the hosted commits are retained.',
      )
  }
  const branch = await git(root, ['branch', '--show-current'])
  const defaultRef = await git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD']).catch(() => '')
  if (
    branch === defaultRef.replace(/^refs\/remotes\/origin\//, '') ||
    !branch ||
    branch === 'main' ||
    branch === 'master'
  )
    await git(root, ['switch', '-c', `copse/openai-${transfer.id}`])
  await adoptCarryOut(root, ref, transfer.base, transfer.tree)
  transfer.imported = true
}
