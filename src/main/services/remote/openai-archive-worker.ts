/** Runs inside the hosted sandbox. The only credential is an expiring archive URL. */
import { readFile, unlink, mkdir, stat, open } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { x, ReadEntry } from 'tar'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import {
  downloadHostedArchive,
  HostedArchiveDownloadError,
} from './openai-archive-download-worker.ts'

const sha = z.string().regex(/^[a-f0-9]{40}$/)
const archiveMetadataSchema = z.object({
  tree: sha,
  snapshotTree: sha,
  commit: z.string().max(4096),
  url: z.url(),
})

export async function setupHostedArchive(
  workspace: string,
  base: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  let stage = 'reading setup metadata'
  try {
    const metadataPath = join(workspace, 'inputs/archive.json')
    const metadata = safeJsonParse(
      await readFile(metadataPath, 'utf8'),
      decodeWithSchema(archiveMetadataSchema),
    )
    await unlink(metadataPath)
    if (!metadata || !sha.safeParse(base).success) throw new Error('Invalid archive setup metadata')
    const url = new URL(metadata.url)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'codeload.github.com' ||
      url.port ||
      url.username ||
      url.password
    )
      throw new Error('Invalid archive download destination')
    const archive = join(workspace, 'inputs/source.tar.gz')
    stage = 'downloading the GitHub archive'
    try {
      if (!fetchImpl) await downloadHostedArchive(url, archive)
      else {
        const response = await fetchImpl(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(240_000),
        })
        stage = `downloading the GitHub archive (HTTP ${String(response.status)})`
        if (!response.ok || !response.body) throw new Error('Archive unavailable')
        let bytes = 0
        const reader = response.body.getReader()
        const output = await open(archive, 'wx', 0o600)
        try {
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            bytes += next.value.byteLength
            if (bytes > 2 * 1024 ** 3) throw new Error('Archive exceeds 2 GiB')
            await output.writeFile(next.value)
          }
        } finally {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
          await output.close()
        }
      }
    } catch (error) {
      if (error instanceof HostedArchiveDownloadError) stage += ` (${error.message})`
      throw error
    }
    stage = 'extracting the GitHub archive'
    const root = join(workspace, 'repo')
    await mkdir(root)
    let unpacked = 0
    let entries = 0
    const rejected: string[] = []
    await x({
      file: archive,
      cwd: root,
      strip: 1,
      strict: true,
      preservePaths: false,
      filter(path, entry): boolean {
        if (!(entry instanceof ReadEntry)) return false
        unpacked += entry.size
        entries++
        if (unpacked > 4 * 1024 ** 3 || entries > 200_000)
          rejected.push('Unsafe archive entry or extraction budget exceeded')
        if (
          path.split('/').some((part) => part === '..' || part.toLowerCase() === '.git') ||
          path.startsWith('/') ||
          !['File', 'Directory', 'SymbolicLink'].includes(entry.type)
        )
          rejected.push('Unsafe archive entry or extraction budget exceeded')
        return rejected.length === 0
      },
    })
    await unlink(archive)
    if (rejected.length) throw new Error('Unsafe archive entry or extraction budget exceeded')
    const git = (args: string[], input?: string): string =>
      execFileSync(
        'git',
        ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args],
        {
          cwd: root,
          encoding: 'utf8',
          input,
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      ).trim()
    stage = 'initializing Git'
    git(['init'])
    git(['add', '--force', '--all'])
    stage = 'verifying the pinned archive tree'
    if (git(['write-tree']) !== metadata.tree)
      throw new Error(
        'GitHub archive tree does not match the pinned revision; archive attributes, LFS or submodules may alter its contents.',
      )
    stage = 'applying local changes'
    const patch = join(workspace, 'inputs/source.bundle')
    if ((await stat(patch)).size)
      git(['apply', '--binary', '--index', '--whitespace=nowarn', patch])
    stage = 'verifying the local snapshot tree'
    if (git(['write-tree']) !== metadata.snapshotTree)
      throw new Error('Local overlay tree mismatch')
    stage = 'verifying the snapshot commit'
    if (git(['hash-object', '-t', 'commit', '-w', '--stdin'], metadata.commit) !== base)
      throw new Error('Snapshot commit mismatch')
    stage = 'checking out the verified snapshot'
    git(['checkout', '-b', 'work', base])
    git(['config', 'user.name', 'Copse'])
    git(['config', 'user.email', 'copse@copse.invalid'])
  } catch {
    throw new Error(`Repository setup failed while ${stage}.`)
  }
}
