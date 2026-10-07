import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { threadDirectoryPath } from '../thread-store.ts'
import { firstNonEmptyString } from '@shared/unknown-value.ts'
import { join, extname } from 'node:path'
import { z } from 'zod'
import { DEFAULT_OPENAI_AGENT_MODEL } from '@shared/openai-cloud-agent.ts'
import {
  buildRemoteAgentContextPreamble,
  promptPayloadFromUserContent,
} from '@shared/remote-agent-stream.ts'
import { resolveApiKey } from '../storage/settings.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import { OpenAiAgentsApi, openAiAgentStateSchema } from './openai-agents-api.ts'
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
})
const active = new Set<string>()
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const storageKey = (threadId: string): string => `openai-agent-owner:${threadId}`
const stateFile = (projectId: string, threadId: string): string =>
  join(threadDirectoryPath(projectId, threadId), 'openai-agent-session.json')

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
  if (payload.images?.length)
    throw new Error('The OpenAI Cloud Agent prototype currently accepts text only.')
  if (!payload.text.trim()) throw new Error('OpenAI Cloud Agent prompt cannot be empty.')
  const model = firstNonEmptyString(options.model?.trim()) ?? DEFAULT_OPENAI_AGENT_MODEL
  const projectId = resolveRemoteAgentProjectId()
  if (!projectId) throw new Error('Open a project before starting an OpenAI cloud agent.')
  const directory = threadDirectoryPath(projectId, options.threadId)
  const path = stateFile(projectId, options.threadId)
  const client = new OpenAiAgentsApi(apiKey, options.fetchImpl)
  const keyHash = hash(apiKey)
  const stored = existsSync(path)
    ? safeJsonParse(readFileSync(path, 'utf8'), decodeWithSchema(savedSchema))
    : null
  if (existsSync(path) && !stored)
    throw new Error('Invalid OpenAI session checkpoint. It has not been replaced.')
  const prior = savedSchema.safeParse(stored)
  if (prior.success && (prior.data.keyHash !== keyHash || prior.data.state.model !== model)) {
    throw new Error(
      'This cloud thread belongs to a different OpenAI key or model. Restore that selection or start a new chat.',
    )
  }
  const state = prior.success ? prior.data.state : await client.create(model, options.signal)
  const promptHash = hash(payload.text)
  if (state.pending && prior.success && prior.data.promptHash !== promptHash) {
    throw new Error(
      'The previous OpenAI task needs recovery. Resend its message before submitting a different task.',
    )
  }
  const save = (): void => {
    mkdirSync(directory, { recursive: true })
    writeFileSync(`${path}.tmp`, JSON.stringify({ state, keyHash, promptHash }), { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
    storageSet(storageKey(options.threadId), projectId)
  }
  save()
  if (!prior.success) {
    await recordRemoteAgentLaunch({
      projectId,
      threadId: options.threadId,
      provider: 'openai',
      agentId: state.sessionId,
      runId: state.sessionId,
      createdAt: Date.now(),
    })
  }
  const notice =
    '_OpenAI hosted workspace · billed to your API key · US session retention, no ZDR. Local files are not mounted. Container and tool charges are additional._\n\n'
  options.onChunk({ type: 'text', text: notice })
  const prompt =
    state.pending?.prompt ??
    (prior.success
      ? payload.text
      : `${buildRemoteAgentContextPreamble({ priorMessages: options.priorMessages ?? [] })}\n\n${payload.text}`)
  const tools = new Set<string>()
  const completedTools = new Set<string>()
  const result = await client.run(state, prompt, {
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
        (item.status === 'completed' || item.status === 'failed' || item.status === 'incomplete') &&
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
  })
  options.onChunk({
    type: 'usage',
    model: `remote-agent:openai#${model}`,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadTokens: result.cacheReadTokens,
  })
  let artifactText = ''
  // Remote paths never select local destinations. Limit automatic transfer per turn.
  const artifactDirectory = join(directory, 'blobs', 'openai-artifacts', hash(state.sessionId))
  let bytes = 0
  for (const artifact of result.artifacts.slice(0, 20)) {
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
      artifactText += `\n[Download artifact (${String(artifact.size_bytes)} bytes)](${target})\n`
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
  const assistantText = notice + result.text + artifactText
  return {
    assistantText,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    messages: [{ role: 'assistant', content: assistantText }],
  }
}
