import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { mkdir, readFile, realpath, stat, writeFile, rename } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { threadDirectoryPath } from '../thread-store.ts'
import { firstNonEmptyString } from '@shared/unknown-value.ts'
import { join, extname, sep } from 'node:path'
import { z } from 'zod'
import { DEFAULT_OPENAI_AGENT_MODEL } from '@shared/openai-cloud-agent.ts'
import { uploadSourceBundle } from './openai-source-upload.ts'
import { openAiImageUrls } from './openai-image-input.ts'
import { getAgentExecutionRoot } from '../execution-root.ts'
import { ensureWritableThreadCheckout } from '../deferred-worktree.ts'
import { prepareGitTransfer, importGitTransfer, gitTransferSchema } from './openai-git-transfer.ts'
import {
  buildRemoteAgentContextPreamble,
  collectPriorPromptImages,
  promptPayloadFromUserContent,
} from '@shared/remote-agent-stream.ts'
import { resolveApiKey } from '../storage/settings.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import {
  OpenAiAgentsApi,
  openAiAgentStateSchema,
  openAiAgentResultSchema,
  type OpenAiAgentResult,
  type OpenAiAgentState,
} from './openai-agents-api.ts'
import { recordRemoteAgentLaunch } from './remote-agent-link-store.ts'
import {
  resolveRemoteAgentProjectId,
  type RemoteAgentRunOptions,
  type RemoteAgentRunResult,
} from './remote-agent-shared.ts'

const savedSchema = z.object({
  state: openAiAgentStateSchema,
  keyHash: z.string(),
  promptHash: z.string(),
  transfer: gitTransferSchema.optional(),
  result: openAiAgentResultSchema.optional(),
  exportResult: openAiAgentResultSchema.optional(),
  sourceFileId: z.string().optional(), // Legacy single-file setup recovery.
  sourceFileIds: z.array(z.string()).optional(),
  usageReported: z.boolean().default(false),
  exportUsageReported: z.boolean().default(false),
})
const active = new Set<string>()
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const storageKey = (threadId: string): string => `openai-agent-owner:${threadId}`
const stateFile = (projectId: string, threadId: string): string =>
  join(threadDirectoryPath(projectId, threadId), 'openai-agent-session.json')

/** Read only a cached artifact belonging to a known thread; never accept a local path. */
export async function readOpenAiArtifact(threadId: string, artifact: string): Promise<Buffer> {
  if (!/^[a-f0-9]{64}\/[a-f0-9]{64}\.[a-zA-Z0-9]{1,10}$/.test(artifact))
    throw new Error('Invalid OpenAI artifact reference.')
  const owner = storageGet(storageKey(threadId))
  if (typeof owner !== 'string') throw new Error('OpenAI artifact thread is unavailable.')
  const directory = threadDirectoryPath(owner, threadId)
  const root = await realpath(directory)
  const target = await realpath(join(directory, 'blobs', 'openai-artifacts', artifact))
  if (!target.startsWith(`${root}${sep}blobs${sep}openai-artifacts${sep}`))
    throw new Error('OpenAI artifact escaped its thread storage.')
  const info = await stat(target)
  if (!info.isFile() || info.size > 10 * 1024 * 1024)
    throw new Error('Invalid OpenAI artifact size.')
  return readFile(target)
}

export function clearOpenAiAgentSession(threadId: string): void {
  const owner = storageGet(storageKey(threadId))
  if (typeof owner === 'string') rmSync(stateFile(owner, threadId), { force: true })
  storageSet(storageKey(threadId), null)
}

export async function runOpenAiAgentFromSettings(
  options: RemoteAgentRunOptions,
): Promise<RemoteAgentRunResult> {
  if (active.has(options.threadId))
    throw new Error('This OpenAI cloud thread already has an active request.')
  active.add(options.threadId)
  try {
    return await run(options)
  } finally {
    active.delete(options.threadId)
  }
}

async function run(options: RemoteAgentRunOptions): Promise<RemoteAgentRunResult> {
  const apiKey = resolveApiKey('openai')
  if (!apiKey)
    throw new Error(
      'Add an OpenAI Platform API key in Settings. ChatGPT sign-in does not authorize this cloud agent.',
    )
  const payload = promptPayloadFromUserContent(options.userPrompt)
  const imageUrls = openAiImageUrls(
    payload.images ?? [],
    collectPriorPromptImages(options.priorMessages ?? []),
  )
  if (!payload.text.trim() && !payload.images?.length)
    throw new Error('OpenAI Cloud Agent prompt cannot be empty.')
  const model = firstNonEmptyString(options.model?.trim()) ?? DEFAULT_OPENAI_AGENT_MODEL
  const projectId = resolveRemoteAgentProjectId()
  if (!projectId) throw new Error('Open a project before starting an OpenAI cloud agent.')
  const directory = threadDirectoryPath(projectId, options.threadId)
  const path = stateFile(projectId, options.threadId)
  const client = new OpenAiAgentsApi(apiKey, options.fetchImpl)
  const keyHash = hash(apiKey)
  const checkpoint = await readFile(path, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  })
  const stored =
    checkpoint === null ? null : safeJsonParse(checkpoint, decodeWithSchema(savedSchema))
  if (checkpoint !== null && !stored)
    throw new Error('Invalid OpenAI session checkpoint. It has not been replaced.')
  const prior = savedSchema.safeParse(stored)
  if (prior.success && (prior.data.keyHash !== keyHash || prior.data.state.model !== model)) {
    throw new Error(
      'This cloud thread belongs to a different OpenAI key or model. Restore that selection or start a new chat.',
    )
  }
  await ensureWritableThreadCheckout()
  const root = getAgentExecutionRoot()
  if (!root) throw new Error('Open a Git checkout before starting a hosted task.')
  if (prior.success && !prior.data.transfer && prior.data.state.pending)
    throw new Error(
      'This older cloud session has a pending task. Recover it with the previous prototype before starting a provisioned chat.',
    )
  const recovering = prior.success && prior.data.transfer && !prior.data.transfer.imported
  const transferDirectory = join(directory, 'blobs', 'openai-git')
  const transfer = recovering
    ? prior.data.transfer
    : await prepareGitTransfer(root, transferDirectory)
  if (!transfer) throw new Error('Hosted snapshot is unavailable.')
  let sourceFileIds = recovering
    ? (prior.data.sourceFileIds ?? (prior.data.sourceFileId ? [prior.data.sourceFileId] : []))
    : []
  const exportCommand = `node /workspace/inputs/copse-git.cjs export ${transfer.base}`
  let state: OpenAiAgentState
  if (recovering) state = prior.data.state
  else {
    const worker = await fs.readFile(join(__dirname, 'openai-git-worker.cjs'))
    sourceFileIds = await uploadSourceBundle(
      client,
      join(transferDirectory, 'source.bundle'),
      options.signal,
    )
    try {
      state = await client.create(model, options.signal, {
        type: 'openai_hosted',
        network: { access: 'enabled' },
        files: [
          ...sourceFileIds.map((file_id, index) => ({
            type: 'file_id' as const,
            file_id,
            path: `/workspace/inputs/source.part-${String(index)}`,
          })),
          {
            type: 'inline',
            data: worker.toString('base64'),
            path: '/workspace/inputs/copse-git.cjs',
          },
        ],
        setup_commands: [
          {
            command: `node /workspace/inputs/copse-git.cjs setup ${transfer.base} ${transfer.ref} ${String(sourceFileIds.length)}`,
          },
        ],
      })
    } catch (error) {
      await Promise.all(
        sourceFileIds.map((id) =>
          client.deleteSource(id, AbortSignal.timeout(20_000)).catch(() => {}),
        ),
      )
      throw error
    }
  }
  const promptHash = hash(payload.images?.length ? JSON.stringify(payload) : payload.text)
  let terminalResult: OpenAiAgentResult | undefined = recovering ? prior.data.result : undefined
  let usageReported = recovering ? prior.data.usageReported : false
  let exportUsageReported = recovering ? prior.data.exportUsageReported : false
  let reportedInput = 0
  let reportedOutput = 0
  let exportResult = recovering ? prior.data.exportResult : undefined
  if (recovering && prior.data.promptHash !== promptHash) {
    throw new Error(
      'The previous hosted task needs recovery. Resend its message to import its commits before starting another task.',
    )
  }
  const save = async (): Promise<void> => {
    await mkdir(directory, { recursive: true })
    await writeFile(
      `${path}.tmp`,
      JSON.stringify({
        state,
        keyHash,
        promptHash,
        transfer,
        result: terminalResult,
        exportResult,
        sourceFileIds,
        usageReported,
        exportUsageReported,
      }),
      { mode: 0o600 },
    )
    await rename(`${path}.tmp`, path)
    storageSet(storageKey(options.threadId), projectId)
  }
  await save()
  if (!recovering) {
    await recordRemoteAgentLaunch({
      projectId,
      threadId: options.threadId,
      provider: 'openai',
      agentId: state.sessionId,
      runId: state.sessionId,
      createdAt: Date.now(),
    })
  }
  if (!terminalResult) {
    await client.waitForEnvironment(state, options.signal)
    if (sourceFileIds.length) {
      for (const id of sourceFileIds) await client.deleteSource(id, options.signal)
      sourceFileIds = []
      await save()
    }
  }
  const prompt =
    state.pending?.prompt ??
    `The exact local working tree is provisioned at /workspace/repo (snapshot ${transfer.base}). Original checkout HEAD: ${transfer.sourceHead}, branch: ${transfer.branch || 'detached'}. This is a history-free snapshot with a synthetic transport commit; do not clone or replace it with a remote branch. Work there. Before finishing, run this exact export command, even if no files changed: ${exportCommand}. Do not offer a patch for manual application; Copse imports the resulting commits locally. Do not push to GitHub.\n\n${buildRemoteAgentContextPreamble({ priorMessages: options.priorMessages ?? [] })}\n\n${payload.text}`
  const tools = new Set<string>()
  const completedTools = new Set<string>()
  const result =
    terminalResult ??
    (await client.run(state, prompt, {
      images: state.pending?.images ?? imageUrls,
      onResult: async (completed) => {
        terminalResult = completed
        await save()
      },
      signal: options.signal,
      save,
      onText: (text) => {
        options.onChunk({ type: 'text', text })
      },
      onItem: (item) => {
        if (item.type !== 'command_execution' || !item.id || !item.command) return
        const id = `openai-${item.id}`
        if (!tools.has(id)) {
          tools.add(id)
          options.onChunk({
            type: 'tool_call',
            toolCall: { id, name: 'run_shell', args: { command: item.command } },
          })
        }
        if (
          (item.status === 'completed' ||
            item.status === 'failed' ||
            item.status === 'incomplete') &&
          !completedTools.has(id)
        ) {
          completedTools.add(id)
          options.onChunk({
            type: 'tool_result',
            toolCallId: id,
            result: typeof item.output === 'string' ? item.output : 'Command output unavailable.',
            isError:
              item.status === 'failed' ||
              (item.exit_code !== null && item.exit_code !== undefined && item.exit_code !== 0),
          })
        }
      },
    }))
  const reportUsage = (usage: OpenAiAgentResult): void => {
    reportedInput += usage.inputTokens
    reportedOutput += usage.outputTokens
    options.onChunk({
      type: 'usage',
      model: `remote-agent:openai#${model}`,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
    })
  }
  if (!usageReported) {
    usageReported = true
    await save()
    reportUsage(result)
  }
  const reportExportUsage = async (): Promise<void> => {
    if (exportResult && !exportUsageReported) {
      exportUsageReported = true
      await save()
      reportUsage(exportResult)
    }
  }
  if (!transfer.imported) {
    await reportExportUsage()
    const isManifest = (artifact: { path: string }): boolean =>
      artifact.path === '/workspace/outputs/copse-result.json' ||
      artifact.path === 'copse-result.json'
    // The API has no host-exec endpoint. Recover a missing export in a separate,
    // checkpointed turn which is never allowed to rerun the user's task.
    if (!result.artifacts.some(isManifest) && !exportResult?.artifacts.some(isManifest)) {
      options.signal.throwIfAborted()
      exportUsageReported = false
      exportResult = await client.run(
        state,
        state.pending?.prompt ??
          `Do not change code or repeat the previous task. Run only: ${exportCommand}. This publishes the repository result for Copse.`,
        {
          signal: options.signal,
          save,
          onText: () => {},
          onResult: async (completed) => {
            exportResult = completed
            await save()
          },
        },
      )
    }
    await reportExportUsage()
    const returnedArtifacts = exportResult?.artifacts ?? result.artifacts
    const manifest = returnedArtifacts.find(
      (a) => a.path === '/workspace/outputs/copse-result.json' || a.path === 'copse-result.json',
    )
    const bundle = returnedArtifacts.find(
      (a) => a.path === '/workspace/outputs/copse.bundle' || a.path === 'copse.bundle',
    )
    if (!manifest)
      throw new Error(
        'The hosted task did not export its repository. Its session and output are retained; no local changes were applied.',
      )
    await writeFile(
      join(transferDirectory, 'copse-result.json'),
      await client.download(state, manifest, options.signal),
      { mode: 0o600 },
    )
    if (bundle)
      await writeFile(
        join(transferDirectory, 'copse.bundle'),
        await client.download(state, bundle, options.signal),
        { mode: 0o600 },
      )
    await importGitTransfer(transfer, root, transferDirectory)
    await save()
  }
  let artifactText = ''
  // Remote paths never select local destinations. Limit automatic transfer per turn.
  const artifactDirectory = join(directory, 'blobs', 'openai-artifacts', hash(state.sessionId))
  let bytes = 0
  for (const artifact of result.artifacts
    .filter(
      (a) =>
        ![
          'copse.bundle',
          'copse-result.json',
          '/workspace/outputs/copse.bundle',
          '/workspace/outputs/copse-result.json',
        ].includes(a.path),
    )
    .slice(0, 20)) {
    bytes += artifact.size_bytes
    if (bytes > 50 * 1024 * 1024 || artifact.size_bytes > 10 * 1024 * 1024) {
      artifactText +=
        '\nAn artifact exceeded the prototype download limit; it remains in the OpenAI session.\n'
      continue
    }
    try {
      const content = await client.download(state, artifact, options.signal)
      await mkdir(artifactDirectory, { recursive: true })
      const extension = extname(artifact.path).match(/^\.[a-zA-Z0-9]{1,10}$/)?.[0] ?? '.bin'
      const target = join(artifactDirectory, `${hash(artifact.id)}${extension}`)
      await writeFile(target, content, { mode: 0o600 })
      const artifactPath = `${hash(state.sessionId)}/${hash(artifact.id)}${extension}`
      const url = `https://api.openai.com/v1/agents/${encodeURIComponent(`openai:${options.threadId}`)}/artifacts/download?path=${encodeURIComponent(artifactPath)}`
      artifactText += `\n[Download artifact (${String(artifact.size_bytes)} bytes)](${url})\n`
    } catch {
      artifactText +=
        '\nArtifact download failed; the published file remains in the OpenAI session.\n'
    }
  }
  if (result.artifacts.length > 20)
    artifactText += '\nAdditional artifacts remain in the OpenAI session.\n'
  if (artifactText) options.onChunk({ type: 'text', text: artifactText })
  if (result.status === 'failed') throw new Error(result.error ?? 'OpenAI cloud turn failed.')
  options.onChunk({
    type: 'done',
    stopReason: result.status === 'cancelled' ? 'CANCELLED' : 'END_TURN',
  })
  const assistantText = result.text + artifactText
  return {
    assistantText,
    inputTokens: reportedInput,
    outputTokens: reportedOutput,
    messages: [{ role: 'assistant', content: assistantText }],
  }
}
