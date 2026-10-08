import { openAiApiError } from './openai-api-error.ts'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { SessionCreateParamsNonStreaming } from 'openai/resources/beta/agents/sessions/sessions'
import { memberOf } from '@copse/std/member-of.ts'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'

const usageSchema = z.object({
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
  input_tokens_details: z.object({ cached_tokens: z.number().nonnegative() }).optional(),
})
const sessionSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['idle', 'in_progress', 'requires_action', 'failed']),
  error: z.string().nullish(),
  usage: usageSchema.nullish(),
  environment: z.object({ id: z.string() }).nullish(),
})
const turnSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['queued', 'in_progress', 'waiting', 'completed', 'failed', 'cancelled']),
  subagent_id: z.string().nullable(),
  error: z.object({ message: z.string() }).nullish(),
})
const itemSchema = z.object({
  id: z.string().nullable(),
  type: z.string(),
  turn_id: z.string(),
  role: z.string().optional(),
  status: z.string().nullish(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  command: z.string().optional(),
  output: z.unknown().optional(),
  exit_code: z.number().nullish(),
})
const artifactSchema = z.object({
  id: z.string().min(1),
  path: z.string(),
  size_bytes: z.number().int().nonnegative(),
  turn_id: z.string(),
})
const eventSchema = z.object({ type: z.string() })

export const openAiAgentStateSchema = z.object({
  v: z.literal(1),
  sessionId: z.string().min(1),
  model: z.string().min(1),
  environmentId: z.string().optional(),
  // A pending submission is written BEFORE sending input. Never blindly replay a task.
  pending: z
    .object({
      key: z.string(),
      prompt: z.string(),
      images: z.array(z.string()).optional(),
      previousTurnIds: z.array(z.string()),
    })
    .nullable(),
  usageInput: z.number().nonnegative(),
  usageOutput: z.number().nonnegative(),
  usageCacheRead: z.number().nonnegative(),
})
export type OpenAiAgentState = z.infer<typeof openAiAgentStateSchema>
export type OpenAiAgentArtifact = z.infer<typeof artifactSchema>
export type OpenAiAgentItem = z.infer<typeof itemSchema>
type AgentTurn = z.infer<typeof turnSchema>

export const openAiAgentResultSchema = z.object({
  status: z.enum(['completed', 'failed', 'cancelled']),
  text: z.string(),
  error: z.string().optional(),
  artifacts: z.array(artifactSchema),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
})
export type OpenAiAgentResult = z.infer<typeof openAiAgentResultSchema>
export type OpenAiHostedEnvironment = Extract<
  NonNullable<SessionCreateParamsNonStreaming['environment']>,
  { type: 'openai_hosted' }
>

export class OpenAiSetupError extends Error {}

export class OpenAiCancellationError extends Error {}
export class OpenAiCancellationUnconfirmedError extends OpenAiCancellationError {}
export class OpenAiCancellationRecoveryError extends OpenAiCancellationError {
  readonly cancellationConfirmed = true
}

/** Thin, fixed-origin beta client. Credentials never enter the hosted environment. */
export class OpenAiAgentsApi {
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch

  constructor(apiKey: string, fetchImpl: typeof fetch = fetch) {
    if (!apiKey.trim()) throw new Error('OpenAI Cloud Agent requires an OpenAI Platform API key.')
    this.apiKey = apiKey
    this.fetchImpl = fetchImpl
  }

  private async request(
    path: string,
    signal: AbortSignal,
    body?: unknown,
    method = 'GET',
    key?: string,
    stream = false,
    resource = '/agents/sessions',
  ): Promise<Response> {
    const response = await this.fetchImpl(`https://api.openai.com/v1${resource}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(stream ? 30_000 : 20_000)]),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'OpenAI-Beta': 'agents=v1',
        Accept: stream ? 'text/event-stream' : 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
      throw await openAiApiError(
        response,
        `${method} ${resource}${path.split('?')[0] ?? ''}`,
        this.apiKey,
      )
    }
    return response
  }

  private async json<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    const parsed = safeJsonParse(await response.text(), decodeWithSchema(schema))
    if (parsed === null) throw new Error('Invalid OpenAI Agents API response.')
    return parsed
  }

  async uploadSource(content: Uint8Array, signal: AbortSignal): Promise<string> {
    if (content.byteLength > 50 * 1024 * 1024) throw new Error('Project snapshot exceeds 50 MiB.')
    const form = new FormData()
    form.set('purpose', 'user_data')
    form.set('file', new Blob([new Uint8Array(content)]), 'source.bundle')
    const response = await this.fetchImpl('https://api.openai.com/v1/files', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    })
    if (!response.ok) {
      throw await openAiApiError(response, 'POST /files (source upload)', this.apiKey)
    }
    return (await this.json(response, z.object({ id: z.string().min(1) }))).id
  }

  async deleteSource(id: string, signal: AbortSignal): Promise<void> {
    await this.request(
      `/${encodeURIComponent(id)}`,
      signal,
      undefined,
      'DELETE',
      undefined,
      false,
      '/files',
    )
  }

  async waitForEnvironment(state: OpenAiAgentState, signal: AbortSignal): Promise<void> {
    if (!state.environmentId) throw new Error('Hosted environment ID is missing.')
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)])
    for (;;) {
      const environment = await this.json(
        await this.request(
          `/${encodeURIComponent(state.environmentId)}`,
          bounded,
          undefined,
          'GET',
          undefined,
          false,
          '/agents/environments',
        ),
        z.object({ status: z.string() }),
      )
      if (environment.status === 'connected') return
      if (environment.status !== 'pending' && environment.status !== 'provisioning')
        throw new OpenAiSetupError(
          'Hosted repository setup failed or expired. Retry to provision a fresh archive URL.',
        )
      await delay(1000, undefined, { signal: bounded })
    }
  }

  async create(
    model: string,
    signal: AbortSignal,
    environment?: OpenAiHostedEnvironment,
  ): Promise<OpenAiAgentState> {
    const body = {
      agent: {
        model,
        instructions:
          'Work only on the requested task. When a repository is provisioned, use /workspace/repo and follow the supplied export command before finishing. The host imports your Git commits and handles GitHub authentication. Never claim a push or PR without evidence. Put other deliverables under /workspace/outputs.',
      },
      environment: environment ?? { type: 'openai_hosted', network: { access: 'enabled' } },
    } satisfies SessionCreateParamsNonStreaming
    // No initial task: persist the session ID before starting billable model work.
    const session = await this.json(await this.request('', signal, body, 'POST'), sessionSchema)
    return {
      v: 1,
      sessionId: session.id,
      ...(session.environment ? { environmentId: session.environment.id } : {}),
      model,
      pending: null,
      usageInput: 0,
      usageOutput: 0,
      usageCacheRead: 0,
    }
  }

  private path(state: OpenAiAgentState): string {
    return `/${encodeURIComponent(state.sessionId)}`
  }

  private async list<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T[]> {
    const values: T[] = []
    const seen = new Set<string>()
    let after: string | undefined
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({ order: 'asc', limit: '100', ...(after ? { after } : {}) })
      const result = await this.json(
        await this.request(`${path}?${query}`, signal),
        z.object({
          data: z.array(schema),
          has_more: z.boolean(),
          last_id: z.string().nullish(),
        }),
      )
      values.push(...result.data)
      if (!result.has_more) return values
      if (!result.last_id || seen.has(result.last_id))
        throw new Error('Invalid OpenAI pagination cursor.')
      after = result.last_id
      seen.add(after)
    }
    throw new Error('OpenAI session history exceeds the prototype pagination limit.')
  }

  private turns(state: OpenAiAgentState, signal: AbortSignal): Promise<AgentTurn[]> {
    return this.list(`${this.path(state)}/turns`, turnSchema, signal)
  }

  private async cancel(state: OpenAiAgentState): Promise<void> {
    const signal = AbortSignal.timeout(20_000)
    await this.request(
      `${this.path(state)}/events`,
      signal,
      { events: [{ type: 'agent.session.input.cancel' }] },
      'POST',
    )
    // 202 is only acceptance. Confirm no active root turn remains.
    for (;;) {
      const turns = await this.turns(state, signal)
      const session = await this.json(await this.request(this.path(state), signal), sessionSchema)
      if (
        session.status === 'idle' &&
        turns.every((turn) => turn.subagent_id !== null || terminal(turn.status))
      )
        return
      await delay(500, undefined, { signal })
    }
  }

  async delete(state: OpenAiAgentState, signal: AbortSignal): Promise<void> {
    await this.request(this.path(state), signal, undefined, 'DELETE')
  }

  async download(
    state: OpenAiAgentState,
    artifact: OpenAiAgentArtifact,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const maxBytes =
      artifact.path === '/workspace/outputs/copse.bundle' || artifact.path === 'copse.bundle'
        ? 200 * 1024 * 1024
        : 10 * 1024 * 1024
    if (artifact.size_bytes > maxBytes)
      throw new Error(
        `Artifact exceeds the ${String(maxBytes / (1024 * 1024))} MiB download limit.`,
      )
    const response = await this.request(
      `${this.path(state)}/artifacts/${encodeURIComponent(artifact.id)}/content`,
      signal,
    )
    if (!response.body) throw new Error('Missing artifact content.')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > maxBytes) throw new Error('Artifact content exceeds the download limit.')
        chunks.push(next.value)
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    if (size !== artifact.size_bytes) throw new Error('Artifact size did not match its metadata.')
    return Buffer.concat(chunks)
  }

  /** Single writer per session. Same pending prompt resumes; a different one must wait. */
  async run(
    state: OpenAiAgentState,
    prompt: string,
    options: {
      signal: AbortSignal
      save: (state: OpenAiAgentState) => void | Promise<void>
      images?: string[]
      onText: (text: string) => void
      onProgress?: (type: string) => void
      onItem?: (item: OpenAiAgentItem) => void
      onResult?: (result: OpenAiAgentResult) => void | Promise<void>
    },
  ): Promise<OpenAiAgentResult> {
    if (!prompt.trim()) throw new Error('OpenAI Cloud Agent prompt cannot be empty.')
    if (
      state.pending &&
      (state.pending.prompt !== prompt ||
        JSON.stringify(state.pending.images ?? []) !== JSON.stringify(options.images ?? []))
    ) {
      throw new Error(
        'An OpenAI task is still pending. Resend the previous message to recover it before starting another task.',
      )
    }
    const controller = new AbortController()
    const signal = AbortSignal.any([
      options.signal,
      controller.signal,
      AbortSignal.timeout(10 * 60_000),
    ])
    const path = this.path(state)
    const emitted = new Set<string>()
    let streamTask: Promise<void> | undefined
    let accepted = state.pending !== null
    const finish = async (
      turn: AgentTurn & { status: 'completed' | 'failed' | 'cancelled' },
      items: OpenAiAgentItem[],
      session: z.infer<typeof sessionSchema>,
      finishSignal: AbortSignal,
    ): Promise<OpenAiAgentResult> => {
      const artifacts = (await this.list(`${path}/artifacts`, artifactSchema, finishSignal)).filter(
        (artifact) => artifact.turn_id === turn.id,
      )
      const usage = session.usage
      const inputTokens = usage ? Math.max(0, usage.input_tokens - state.usageInput) : 0
      const outputTokens = usage ? Math.max(0, usage.output_tokens - state.usageOutput) : 0
      const cacheReadTokens = usage
        ? Math.max(0, (usage.input_tokens_details?.cached_tokens ?? 0) - state.usageCacheRead)
        : 0
      if (usage) {
        state.usageInput = usage.input_tokens
        state.usageOutput = usage.output_tokens
        state.usageCacheRead = usage.input_tokens_details?.cached_tokens ?? 0
      }
      const result: OpenAiAgentResult = {
        status: turn.status,
        text: items.map(messageText).filter(Boolean).join('\n\n'),
        error: turn.error?.message,
        artifacts,
        inputTokens,
        outputTokens,
        cacheReadTokens,
      }
      await options.onResult?.(result)
      state.pending = null
      await options.save(state)
      return result
    }
    try {
      const existing = await this.turns(state, signal)
      if (!state.pending) {
        if (existing.some((turn) => turn.subagent_id === null && !terminal(turn.status)))
          throw new Error('This OpenAI session already has an active turn.')
        state.pending = {
          key: randomUUID(),
          prompt,
          ...(options.images?.length ? { images: options.images } : {}),
          previousTurnIds: existing.map((turn) => turn.id),
        }
        await options.save(state)
      }
      const pending = state.pending
      // Subscribe BEFORE submitting. On loss, saved items/turns are authoritative.
      try {
        const response = await this.request(
          `${path}/events`,
          signal,
          undefined,
          'GET',
          undefined,
          true,
        )
        if (response.body) {
          streamTask = followProgress(response.body, signal, options.onProgress).catch(() => {
            if (!signal.aborted) options.onProgress?.('recovering')
          })
        }
      } catch {
        signal.throwIfAborted()
        options.onProgress?.('recovering')
      }

      if (
        !existing.some(
          (turn) => turn.subagent_id === null && !pending.previousTurnIds.includes(turn.id),
        )
      ) {
        accepted = true // Delivery can be ambiguous even if fetch throws.
        await this.request(
          `${path}/events`,
          signal,
          {
            events: [
              {
                type: 'agent.session.input.message',
                input: [
                  {
                    role: 'user',
                    content: [
                      { type: 'input_text', text: prompt },
                      ...(pending.images ?? []).map((image_url) => ({
                        type: 'input_image',
                        image_url,
                      })),
                    ],
                  },
                ],
              },
            ],
          },
          'POST',
          pending.key,
        )
      }
      for (;;) {
        const turns = await this.turns(state, signal)
        const turn = turns.find(
          (entry) => entry.subagent_id === null && !pending.previousTurnIds.includes(entry.id),
        )
        const session = await this.json(await this.request(path, signal), sessionSchema)
        const items = turn
          ? (await this.list(`${path}/items`, itemSchema, signal)).filter(
              (item) => item.turn_id === turn.id,
            )
          : []
        for (const item of items) {
          options.onItem?.(item)
          const text = messageText(item)
          if (item.id && item.status === 'completed' && text && !emitted.has(item.id)) {
            emitted.add(item.id)
            options.onText(`${text}\n\n`)
          }
        }
        if (turn && terminal(turn.status)) {
          return await finish({ ...turn, status: turn.status }, items, session, signal)
        }
        if (session.status === 'failed') throw new Error(session.error ?? 'OpenAI session failed.')
        if (session.status === 'requires_action' || turn?.status === 'waiting')
          throw new Error(
            'OpenAI requires an action this prototype cannot handle. The task remains linked for recovery.',
          )
        await delay(1_500, undefined, { signal })
      }
    } catch (error) {
      if (signal.aborted && accepted) {
        try {
          await this.cancel(state)
        } catch {
          throw new OpenAiCancellationUnconfirmedError(
            `OpenAI cancellation could not be confirmed. Session ${state.sessionId} may still be running; recover it before starting another task.`,
          )
        }
        // Recover terminal output and billable usage with an independent signal.
        // Keep the pending submission if this read fails so the next run can recover it.
        try {
          const recoverySignal = AbortSignal.timeout(25_000)
          const turns = await this.turns(state, recoverySignal)
          const turn = turns.find(
            (entry) =>
              entry.subagent_id === null && !state.pending?.previousTurnIds.includes(entry.id),
          )
          if (!turn || !terminal(turn.status))
            throw new Error(
              'Cancellation was confirmed but the submitted turn could not be recovered. The session remains linked; resend the previous message to inspect it.',
              { cause: error },
            )
          const session = await this.json(await this.request(path, recoverySignal), sessionSchema)
          const items = (await this.list(`${path}/items`, itemSchema, recoverySignal)).filter(
            (item) => item.turn_id === turn.id,
          )
          for (const item of items) {
            const text = messageText(item)
            if (item.id && text && !emitted.has(item.id)) options.onText(`${text}\n\n`)
          }
          return await finish({ ...turn, status: turn.status }, items, session, recoverySignal)
        } catch (recoveryError) {
          throw new OpenAiCancellationRecoveryError(
            `OpenAI cancellation was confirmed, but output, usage, or artifacts could not be recovered. Session ${state.sessionId} remains linked; resend the previous message to recover it before starting another task.`,
            { cause: recoveryError },
          )
        }
      }
      throw error
    } finally {
      controller.abort()
      await streamTask
    }
  }
}

const terminal = memberOf(['completed', 'failed', 'cancelled'] as const)

function messageText(item: OpenAiAgentItem): string {
  return item.type === 'message' && item.role === 'assistant'
    ? (item.content
        ?.filter((part) => part.type === 'output_text')
        .map((part) => part.text ?? '')
        .join('') ?? '')
    : ''
}

async function followProgress(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onProgress: ((type: string) => void) | undefined,
): Promise<void> {
  const reader = body.getReader()
  const abort = (): void => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    signal.throwIfAborted()
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      buffer += decoder.decode(next.value, { stream: true })
      if (buffer.length > 1_048_576) throw new Error('OpenAI event exceeds prototype limit.')
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trimEnd()
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith('data:')) continue
        const event = safeJsonParse(line.slice(5).trim(), decodeWithSchema(eventSchema))
        if (event) onProgress?.(event.type)
      }
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
