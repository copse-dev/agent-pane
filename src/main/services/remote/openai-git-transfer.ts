import { MAX_SOURCE_PARTS, SOURCE_PART_BYTES } from './openai-source-upload.ts'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import {
  createSnapshotCommit,
  writeCarryInBundle,
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

/** Use the container snapshot algorithm, but omit history and repository configuration. */
export async function prepareGitTransfer(
  root: string,
  directory: string,
  archiveCommit?: string,
): Promise<GitTransfer> {
  root = await realpath(root)
  await mkdir(directory, { recursive: true })
  const sourceHead = await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => null)
  if (!sourceHead) throw new Error('Make an initial Git commit before starting a hosted task.')
  const branch = await git(root, ['branch', '--show-current'])
  const snapshot = await createSnapshotCommit(root)
  if (
    (await git(root, ['ls-tree', '-r', snapshot.sha]))
      .split('\n')
      .some((line) => line.startsWith('160000 '))
  )
    throw new Error('Hosted snapshots do not yet support Git submodules.')
  for (const revision of [snapshot.sha, ...(archiveCommit ? [archiveCommit] : [])]) {
    const attributes = await exec(
      'git',
      [
        'grep',
        '-I',
        '-E',
        'filter[=[:space:]]+lfs',
        revision,
        '--',
        '.gitattributes',
        '**/.gitattributes',
      ],
      { cwd: root },
    )
      .then(() => true)
      .catch((error: unknown) => {
        if (z.object({ code: z.literal(1) }).safeParse(error).success) return false
        throw error
      })
    const pointers = await exec(
      'git',
      ['grep', '-I', '-l', '-E', '^version https://git-lfs.github.com/spec/v1$', revision],
      { cwd: root, maxBuffer: 1024 * 1024 },
    )
      .then(() => true)
      .catch((error: unknown) => {
        if (z.object({ code: z.literal(1) }).safeParse(error).success) return false
        throw error
      })
    const config = await git(root, ['ls-tree', '--name-only', revision, '--', '.lfsconfig'])
    if (attributes || pointers || config)
      throw new Error(
        'Git LFS repositories are not supported by OpenAI archive provisioning yet. No hosted session was created.',
      )
  }
  const tree = await git(root, ['rev-parse', `${snapshot.sha}^{tree}`])
  const base = await git(root, [
    '-c',
    'user.name=Copse',
    '-c',
    'user.email=copse@copse.invalid',
    'commit-tree',
    tree,
    '-m',
    'Copse hosted snapshot',
  ])
  const id = randomUUID()
  const bundle = join(directory, 'source.bundle')
  const ref = `refs/copse/carry-in/${id}`
  if (archiveCommit) {
    const patch = await exec(
      'git',
      [
        'diff',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        '--no-textconv',
        archiveCommit,
        base,
        '--',
      ],
      { cwd: root, encoding: 'buffer', maxBuffer: 49 * 1024 * 1024 },
    ).catch((error: unknown) => {
      if (
        z.object({ code: z.literal('ERR_CHILD_PROCESS_STDIO_MAXBUFFER') }).safeParse(error).success
      )
        throw new Error(
          'Local changes exceed the hosted upload budget. Push them to GitHub and fetch origin before retrying.',
        )
      throw error
    })
    await writeFile(bundle, patch.stdout)
    await writeFile(
      join(directory, 'archive-metadata.json'),
      JSON.stringify({
        tree: await git(root, ['rev-parse', `${archiveCommit}^{tree}`]),
        snapshotTree: tree,
        commit: (await exec('git', ['cat-file', 'commit', base], { cwd: root })).stdout,
      }),
    )
  } else await writeCarryInBundle(root, id, bundle, base)
  if ((await stat(bundle)).size > SOURCE_PART_BYTES * MAX_SOURCE_PARTS)
    throw new Error('Project snapshot exceeds the 49-part hosted transfer budget (1568 MiB).')
  await git(root, ['update-ref', `refs/copse/openai/${id}`, base])
  return { id, root, base, tree, sourceHead, branch, ref, imported: false }
}

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
