import { MAX_SOURCE_PARTS, SOURCE_PART_BYTES } from './openai-source-upload.ts'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { snapshotWorkingTree } from '../git-snapshot.mts'
import type { GitTransfer } from './openai-git-transfer.ts'
const exec = promisify(execFile)
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
  const snapshot = await snapshotWorkingTree(
    async (args, env) =>
      (
        await exec(
          'git',
          ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
          {
            cwd: root,
            env: { ...process.env, ...env },
            maxBuffer: 64 * 1024 * 1024,
          },
        )
      ).stdout.trim(),
    {
      message: 'copse: working-tree snapshot for a container run',
      identity: { name: 'copse', email: 'copse@copse.invalid' },
    },
  )
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
  } else {
    await git(root, ['update-ref', ref, base])
    try {
      await git(root, ['bundle', 'create', bundle, ref])
    } finally {
      await git(root, ['update-ref', '-d', ref])
    }
  }
  if ((await stat(bundle)).size > SOURCE_PART_BYTES * MAX_SOURCE_PARTS)
    throw new Error('Project snapshot exceeds the 49-part hosted transfer budget (1568 MiB).')
  await git(root, ['update-ref', `refs/copse/openai/${id}`, base])
  return { id, root, base, tree, sourceHead, branch, ref, imported: false }
}
