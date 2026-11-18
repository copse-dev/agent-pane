import { MAX_SOURCE_PARTS, SOURCE_PART_BYTES } from './openai-source-upload.ts'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { snapshotWorkingTree } from '../git-snapshot.mts'
import {
  internalGit as git,
  internalGitBuffer,
  internalGitBundleCreate,
  internalGitRaw,
} from '../security/internal-git-exec.ts'
import type { GitTransfer } from './openai-git-transfer.ts'

/** `git grep` exits 1 for "no match": that is an answer, not a failure. */
const matched = (search: Promise<unknown>): Promise<boolean> =>
  search.then(
    () => true,
    (error: unknown) => {
      if (z.object({ code: z.literal(1) }).safeParse(error).success) return false
      throw error
    },
  )

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
  const snapshot = await snapshotWorkingTree((args, env) => git(root, args, env ? { env } : {}), {
    message: 'copse: working-tree snapshot for a container run',
    identity: { name: 'copse', email: 'copse@copse.invalid' },
  })
  if (
    (await git(root, ['ls-tree', '-r', snapshot.sha]))
      .split('\n')
      .some((line) => line.startsWith('160000 '))
  )
    throw new Error('Hosted snapshots do not yet support Git submodules.')
  for (const revision of [snapshot.sha, ...(archiveCommit ? [archiveCommit] : [])]) {
    const attributes = await matched(
      git(root, [
        'grep',
        '-I',
        '-E',
        'filter[=[:space:]]+lfs',
        revision,
        '--',
        '.gitattributes',
        '**/.gitattributes',
      ]),
    )
    const pointers = await matched(
      git(
        root,
        ['grep', '-I', '-l', '-E', '^version https://git-lfs.github.com/spec/v1$', revision],
        { maxBuffer: 1024 * 1024 },
      ),
    )
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
    const patch = await internalGitBuffer(
      root,
      ['diff', '--binary', '--full-index', archiveCommit, base, '--'],
      { maxBuffer: 49 * 1024 * 1024 },
    ).catch((error: unknown) => {
      if (
        z.object({ code: z.literal('ERR_CHILD_PROCESS_STDIO_MAXBUFFER') }).safeParse(error).success
      )
        throw new Error(
          'Local changes exceed the hosted upload budget. Push them to GitHub and fetch origin before retrying.',
        )
      throw error
    })
    await writeFile(bundle, patch)
    await writeFile(
      join(directory, 'archive-metadata.json'),
      JSON.stringify({
        tree: await git(root, ['rev-parse', `${archiveCommit}^{tree}`]),
        snapshotTree: tree,
        // Untrimmed: the guest re-hashes these exact bytes to verify `base`.
        commit: await internalGitRaw(root, ['cat-file', 'commit', base]),
      }),
    )
  } else {
    await git(root, ['update-ref', ref, base])
    try {
      await internalGitBundleCreate(root, bundle, [ref])
    } finally {
      await git(root, ['update-ref', '-d', ref])
    }
  }
  if ((await stat(bundle)).size > SOURCE_PART_BYTES * MAX_SOURCE_PARTS)
    throw new Error('Project snapshot exceeds the 49-part hosted transfer budget (1568 MiB).')
  await git(root, ['update-ref', `refs/copse/openai/${id}`, base])
  return { id, root, base, tree, sourceHead, branch, ref, imported: false }
}
