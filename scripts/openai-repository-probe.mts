import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, rename, mkdir, stat, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import {
  OpenAiAgentsApi,
  openAiAgentStateSchema,
} from '../src/main/services/remote/openai-agents-api.ts'
import { prepareGitTransfer } from '../src/main/services/remote/openai-git-snapshot.ts'
import { githubArchiveBase } from '../src/main/services/remote/openai-archive-base.ts'
import { requestGithubArchiveUrl } from '../src/main/services/remote/openai-archive-download.ts'
import { repositoryEnvironment } from '../src/main/services/remote/openai-repository-environment.ts'
import { uploadSourceBundle } from '../src/main/services/remote/openai-source-upload.ts'

const exec = promisify(execFile)
const checkpointSchema = z.object({
  kind: z.literal('repository-probe'),
  state: openAiAgentStateSchema.optional(),
  sourceFileIds: z.array(z.string()),
})
type Checkpoint = z.infer<typeof checkpointSchema>
const save = async (path: string, checkpoint: Checkpoint): Promise<void> => {
  await writeFile(`${path}.tmp`, JSON.stringify(checkpoint), { mode: 0o600 })
  await rename(`${path}.tmp`, path)
}

export async function deleteRepositoryProbe(
  path: string,
  client: OpenAiAgentsApi,
): Promise<boolean> {
  const checkpoint = safeJsonParse(await readFile(path, 'utf8'), decodeWithSchema(checkpointSchema))
  if (!checkpoint) return false
  if (checkpoint.state) {
    await client.delete(checkpoint.state, AbortSignal.timeout(20_000))
    delete checkpoint.state
    await save(path, checkpoint)
  }
  for (const id of [...checkpoint.sourceFileIds]) {
    await client.deleteSource(id, AbortSignal.timeout(20_000))
    checkpoint.sourceFileIds = checkpoint.sourceFileIds.filter((value) => value !== id)
    await save(path, checkpoint)
  }
  await rename(path, `${path}.deleted`)
  console.log('Diagnostic session and uploaded files deleted.')
  return true
}

export async function probeRepository(options: {
  root: string
  statePath: string
  model: string
  client: OpenAiAgentsApi
  signal: AbortSignal
  bundleDirectory: string
  fetchImpl?: typeof fetch
}): Promise<void> {
  const { root, statePath, model, client, signal, bundleDirectory } = options
  await mkdir(dirname(statePath), { recursive: true })
  const checkpoint: Checkpoint = { kind: 'repository-probe', sourceFileIds: [] }
  // Exclusive creation also prevents accidental reuse of a diagnostic for inference.
  await writeFile(statePath, JSON.stringify(checkpoint), { flag: 'wx', mode: 0o600 })
  const directory = await mkdtemp(join(tmpdir(), 'copse-repository-probe-'))
  let pinned: { id: string; base: string } | undefined
  try {
    console.log('Preparing the current checkout snapshot; no inference will run.')
    const archive = await githubArchiveBase(root)
    const transfer = await prepareGitTransfer(root, directory, archive.commit)
    pinned = transfer
    const metadataText = await readFile(join(directory, 'archive-metadata.json'), 'utf8')
    const metadata = safeJsonParse(
      metadataText,
      decodeWithSchema(
        z.object({ tree: z.string(), snapshotTree: z.string(), commit: z.string() }),
      ),
    )
    if (!metadata) throw new Error('Invalid archive metadata')
    const worker = await readFile(join(bundleDirectory, 'openai-probe-git-worker.cjs'))
    const diagnostic = await readFile(join(bundleDirectory, 'openai-probe-diagnostic-worker.cjs'))
    if (
      (await stat(join(directory, 'source.bundle'))).size +
        worker.length +
        diagnostic.length +
        Buffer.byteLength(metadataText) +
        16_384 >
      50 * 1024 * 1024
    )
      throw new Error('Repository diagnostic exceeds the 50 MiB upload budget.')
    checkpoint.sourceFileIds = await uploadSourceBundle(
      client,
      join(directory, 'source.bundle'),
      signal,
    )
    await save(statePath, checkpoint)
    const token =
      process.env['GH_TOKEN'] ??
      process.env['GITHUB_TOKEN'] ??
      (await exec('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 10_000 }).then(
        (result) => result.stdout.trim(),
        () => null,
      ))
    const url = await requestGithubArchiveUrl(
      archive.repository,
      archive.commit,
      signal,
      token,
      options.fetchImpl,
    )
    const environment = repositoryEnvironment(
      worker,
      metadata,
      transfer,
      checkpoint.sourceFileIds,
      url,
    )
    environment.files?.push({
      type: 'inline',
      data: diagnostic.toString('base64'),
      path: '/workspace/inputs/copse-diagnostic.cjs',
    })
    // CLI diagnostic only: allow connection after failure to inspect fixed marker names.
    // The app still uses the original fail-closed command, and this mode never calls run().
    environment.setup_commands = [
      {
        command: `mkdir -p /workspace/copse-diagnostics && touch /workspace/copse-diagnostics/00-shell-started; node /workspace/inputs/copse-diagnostic.cjs /workspace ${transfer.base} ${transfer.ref} ${String(checkpoint.sourceFileIds.length)} >/dev/null 2>&1 || touch /workspace/copse-diagnostics/failed-node-or-wrapper; true`,
      },
    ]
    checkpoint.state = await client.create(model, signal, environment)
    await save(statePath, checkpoint)
    console.log(
      `Session: ${checkpoint.state.sessionId}\nEnvironment: ${checkpoint.state.environmentId ?? 'missing'}`,
    )
    console.log('Waiting for repository diagnostic setup...')
    await client.waitForEnvironment(checkpoint.state, signal)
    const files = await client.setupDiagnosticFiles(checkpoint.state, signal)
    const markers = files
      .map((path) => path.replace(/^\/workspace\/copse-diagnostics\//, ''))
      .filter((name) =>
        /^(?:0[0-5]-[a-z-]+|failed-[a-z-]+|http-[1-5][0-9]{2}|runtime-node-[0-9]+|runtime-(?:fetch-present|fetch-missing|https-proxy-present))$/.test(
          name,
        ),
      )
      .sort()
    for (const marker of markers) console.log(`Setup: ${marker}`)
    if (
      !markers.includes('05-snapshot-verified') ||
      markers.some((marker) => marker.startsWith('failed-'))
    )
      throw new Error(
        'Repository diagnostic failed; share the Setup lines and session/environment IDs. No inference was submitted.',
      )
    console.log(
      'Repository snapshot verified. No inference, commits, or GitHub pushes were requested.',
    )
  } finally {
    await deleteRepositoryProbe(statePath, client).catch(() => {
      console.error(`Cleanup incomplete. Retry --delete --state ${statePath}`)
      process.exitCode = 1
    })
    if (pinned)
      await exec('git', ['update-ref', '-d', `refs/copse/openai/${pinned.id}`, pinned.base], {
        cwd: root,
      }).catch(() => {
        console.error('Could not remove the diagnostic snapshot reference.')
      })
    await rm(directory, { recursive: true, force: true })
  }
}
