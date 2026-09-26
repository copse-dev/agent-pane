import {
  client,
  methods,
  PROTOCOL_VERSION,
  type ClientConnection,
  type InitializeResponse,
  type LoadSessionResponse,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionConfigSelectOption,
  type SessionUpdate,
  type Stream,
} from '@agentclientprotocol/sdk'
import { randomInt } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { acpProbeErrorMessage, spawnProbeTransport } from './acp-behavior-probe.ts'

/**
 * Tier-2 ACP **session-continuity probe** (docs/plans/acp-session-continuity.md):
 * does an agent's conversation survive its process being restarted — and
 * restarted into a *different working directory*?
 *
 * The capability probe can only read what an agent advertises. Advertising
 * `loadSession` or `sessionCapabilities.resume` says the method exists, not
 * that a session created under one `cwd` can be found from another: an agent
 * that files transcripts per directory may reject the request, or worse,
 * accept it and continue with no memory. Only a remembered fact tells those
 * apart, so every trial here:
 *
 *  1. starts the agent in the origin directory and plants a random codeword
 *     in a new session;
 *  2. kills that process and spawns a fresh one in the target directory
 *     (the origin again, or a second directory);
 *  3. reattaches with `session/load` or `session/resume` and asks for the
 *     codeword and the working directory the agent now believes it has.
 *
 * Each trial seeds its own session so one method's success cannot leak into
 * another's. A cross-directory success is followed by a second restart in the
 * new directory, because a worktree-bound thread will be reaped and resumed
 * there again. Spends model tokens (~2–3 short prompts per trial): opt-in only
 * (`npm run probe:acp -- --continuity`).
 */

export type AcpContinuityMethod = 'load' | 'resume'
export type AcpContinuityCwd = 'same' | 'new'

/**
 * What one reattach did:
 * - `recalled` — the method succeeded and the agent knew the codeword;
 * - `forgot` — the method succeeded but the agent did not (the dangerous
 *   case: it looks like continuity and is not);
 * - `rejected` — the agent refused the method call;
 * - `unsupported` — the agent does not advertise the method, so it was not tried;
 * - `error` — the trial could not run (seeding or spawning failed).
 */
export type AcpContinuityOutcome = 'recalled' | 'forgot' | 'rejected' | 'unsupported' | 'error'

export interface AcpContinuityTrial {
  method: AcpContinuityMethod
  cwd: AcpContinuityCwd
  outcome: AcpContinuityOutcome
  /** Message updates the agent replayed during `session/load` (0 for resume). */
  replayedMessages: number
  /** Whether that replay contained the codeword — proof of history without a prompt. */
  replayHadCodeword: boolean
  /**
   * The directory the agent said it is working in after reattaching, classified
   * against the two directories: `target` is the one it was restarted in.
   */
  reportedCwd: 'target' | 'origin' | 'other' | null
  /**
   * For a successful new-directory trial: whether a further restart in that
   * directory still recalls. `null` when not attempted.
   */
  survivesSecondRestart: boolean | null
  /** The start of the agent's recall answer, so a `forgot` can be read. */
  answerPreview?: string
  error?: string
}

export interface AcpContinuitySnapshot {
  agentVersion: string | null
  advertised: { load: boolean; resume: boolean }
  trials: AcpContinuityTrial[]
}

export interface AcpContinuityProbeConfig {
  agentId: string
  title: string
  command: string
  args?: string[]
  env?: Record<string, string>
  /** Directory the seeded session is created in. */
  originCwd: string
  /** A second, distinct directory the agent is restarted into. */
  otherCwd: string
}

export interface AcpContinuityProbeOptions {
  /** Per-prompt timeout. Default 120s. */
  turnTimeoutMs?: number
  /** Which methods to exercise. Default both. */
  methods?: readonly AcpContinuityMethod[]
  /**
   * Case-insensitive substring of the model to run the trials on. Without it
   * the agent's configured default is used, which may not be one it can reach.
   */
  model?: string
  /** Deterministic codewords for tests. */
  codeword?: () => string
  createTransport?: (config: {
    command: string
    args?: string[]
    env?: Record<string, string>
    cwd: string
  }) => Promise<{ stream: Stream; dispose: () => void }>
}

const WORDS = ['HERON', 'LANTERN', 'QUARRY', 'MARIGOLD', 'TUNDRA', 'BISCUIT', 'COMET', 'FJORD']

function defaultCodeword(): string {
  return `${WORDS[randomInt(WORDS.length)] ?? 'HERON'}-${String(randomInt(1000, 10000))}`
}

export function seedPrompt(codeword: string): string {
  return (
    `Remember this codeword for later in our conversation: ${codeword}. ` +
    'Do not use any tools. Reply with just "OK".'
  )
}

export const RECALL_PROMPT =
  'Do not use any tools. Answer on exactly two lines. Line 1: the codeword I asked you to ' +
  'remember earlier in this conversation, or UNKNOWN if you have none. Line 2: the absolute ' +
  'path of your current working directory as stated in your environment.'

function canonicalDir(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Classify the directory named in the agent's answer. Pure; exported for tests. */
export function classifyReportedCwd(
  answer: string,
  target: string,
  origin: string,
): AcpContinuityTrial['reportedCwd'] {
  const candidates = answer
    .split(/\s+/)
    .map((token) => token.replace(/^[`'"(]+|[`'".,;:)]+$/g, ''))
    .filter((token) => token.startsWith('/'))
    .map((token) => canonicalDir(token.replace(/\/+$/, '')))
  if (candidates.length === 0) return null
  const t = canonicalDir(target)
  const o = canonicalDir(origin)
  if (candidates.includes(t)) return 'target'
  if (candidates.includes(o)) return 'origin'
  return 'other'
}

function textOf(update: SessionUpdate): string {
  if (
    (update.sessionUpdate === 'agent_message_chunk' ||
      update.sessionUpdate === 'user_message_chunk') &&
    update.content.type === 'text'
  ) {
    return update.content.text
  }
  return ''
}

interface ProbeConnection {
  init: InitializeResponse
  /** Updates received for any session, in arrival order. */
  updates: SessionUpdate[]
  agent: ClientConnection['agent']
  dispose: () => void
}

async function connect(
  config: AcpContinuityProbeConfig,
  cwd: string,
  createTransport: NonNullable<AcpContinuityProbeOptions['createTransport']>,
): Promise<ProbeConnection> {
  const transport = await createTransport({
    command: config.command,
    ...(config.args ? { args: config.args } : {}),
    ...(config.env ? { env: config.env } : {}),
    cwd,
  })
  const updates: SessionUpdate[] = []
  const app = client({ name: 'copse-continuity-probe' })
    .onNotification(methods.client.session.update, (ctx) => {
      updates.push(ctx.params.update)
    })
    // Tools are declined: the prompts ask for none, and a probe must not act.
    .onRequest(methods.client.session.requestPermission, () => ({
      outcome: { outcome: 'cancelled' as const },
    }))
  const connection = app.connect(transport.stream)
  const dispose = (): void => {
    connection.close()
    transport.dispose()
  }
  try {
    const init = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    })
    return { init, updates, agent: connection.agent, dispose }
  } catch (err) {
    dispose()
    throw err
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} timed out after ${String(ms)}ms`))
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer)
  })
}

/** Send one prompt and return the agent's text for that turn. */
async function ask(
  conn: ProbeConnection,
  sessionId: string,
  text: string,
  timeoutMs: number,
): Promise<string> {
  const start = conn.updates.length
  await withTimeout(
    conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'text', text }],
    }),
    timeoutMs,
    'session/prompt',
  )
  // Notifications precede the response on the wire; let the last ones land.
  await new Promise((resolve) => setTimeout(resolve, 50))
  return conn.updates
    .slice(start)
    .filter((update) => update.sessionUpdate === 'agent_message_chunk')
    .map(textOf)
    .join('')
}

async function reattach(
  conn: ProbeConnection,
  method: AcpContinuityMethod,
  sessionId: string,
  cwd: string,
): Promise<{ replay: SessionUpdate[]; response: LoadSessionResponse | ResumeSessionResponse }> {
  const start = conn.updates.length
  const response =
    method === 'load'
      ? await conn.agent.request(methods.agent.session.load, { sessionId, cwd, mcpServers: [] })
      : await conn.agent.request(methods.agent.session.resume, { sessionId, cwd, mcpServers: [] })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const replay = conn.updates
    .slice(start)
    .filter(
      (update) =>
        update.sessionUpdate === 'user_message_chunk' ||
        update.sessionUpdate === 'agent_message_chunk',
    )
  return { replay, response }
}

/**
 * Switch the session to the model matching `hint` (a case-insensitive
 * substring of a model choice), so a probe is not at the mercy of whatever
 * default the agent's own config names. No hint → the agent's default.
 */
async function pinModel(
  conn: ProbeConnection,
  sessionId: string,
  response: { configOptions?: SessionConfigOption[] | null },
  hint: string | undefined,
): Promise<void> {
  if (!hint) return
  // Read the selector straight off the wire shape: the client's richer parser
  // lives in acp-client.ts, whose import graph does not bundle into a probe CLI.
  const option = (response.configOptions ?? []).find(
    (candidate) => candidate.category === 'model' && candidate.type === 'select',
  )
  if (option?.type !== 'select') throw new Error(`no model selector to match "${hint}"`)
  const choices: SessionConfigSelectOption[] = option.options.flatMap((entry) =>
    'group' in entry ? entry.options : [entry],
  )
  const needle = hint.toLowerCase()
  const choice = choices.find(
    (candidate) =>
      candidate.value.toLowerCase().includes(needle) ||
      candidate.name.toLowerCase().includes(needle),
  )
  if (!choice) throw new Error(`no model choice matches "${hint}"`)
  if (option.currentValue === choice.value) return
  await conn.agent.request(methods.agent.session.setConfigOption, {
    sessionId,
    configId: option.id,
    value: choice.value,
  })
}

function advertises(init: InitializeResponse, method: AcpContinuityMethod): boolean {
  const caps = init.agentCapabilities
  if (method === 'load') return caps?.loadSession === true
  const resume = caps?.sessionCapabilities?.resume
  return resume !== undefined && resume !== null
}

/**
 * Run the continuity trials against one agent. Never throws: a failure to even
 * initialize is reported as `{ ok: false }`, and a failed trial is recorded in
 * place so the others still run.
 */
export async function probeAgentContinuity(
  config: AcpContinuityProbeConfig,
  options: AcpContinuityProbeOptions = {},
): Promise<{ ok: true; snapshot: AcpContinuitySnapshot } | { ok: false; error: string }> {
  const turnTimeoutMs = options.turnTimeoutMs ?? 120_000
  const createTransport = options.createTransport ?? spawnProbeTransport
  const nextCodeword = options.codeword ?? defaultCodeword
  const probeMethods = options.methods ?? ['load', 'resume']

  let advertised: AcpContinuitySnapshot['advertised']
  let agentVersion: string | null
  let canDelete: boolean
  try {
    const first = await connect(config, config.originCwd, createTransport)
    advertised = { load: advertises(first.init, 'load'), resume: advertises(first.init, 'resume') }
    const del = first.init.agentCapabilities?.sessionCapabilities?.delete
    canDelete = del !== undefined && del !== null
    agentVersion = first.init.agentInfo?.version ?? null
    first.dispose()
  } catch (err) {
    return { ok: false, error: acpProbeErrorMessage(err) }
  }

  const trials: AcpContinuityTrial[] = []
  for (const method of probeMethods) {
    for (const cwdKind of ['same', 'new'] as const) {
      const base = {
        method,
        cwd: cwdKind,
        replayedMessages: 0,
        replayHadCodeword: false,
        reportedCwd: null,
        survivesSecondRestart: null,
      }
      if (!advertised[method]) {
        trials.push({ ...base, outcome: 'unsupported' })
        continue
      }
      trials.push(
        await runTrial(
          config,
          method,
          cwdKind,
          nextCodeword(),
          createTransport,
          turnTimeoutMs,
          options.model,
          canDelete,
        ),
      )
    }
  }
  return { ok: true, snapshot: { agentVersion, advertised, trials } }
}

async function runTrial(
  config: AcpContinuityProbeConfig,
  method: AcpContinuityMethod,
  cwdKind: AcpContinuityCwd,
  codeword: string,
  createTransport: NonNullable<AcpContinuityProbeOptions['createTransport']>,
  turnTimeoutMs: number,
  modelHint: string | undefined,
  canDelete: boolean,
): Promise<AcpContinuityTrial> {
  const target = cwdKind === 'same' ? config.originCwd : config.otherCwd
  const trial: AcpContinuityTrial = {
    method,
    cwd: cwdKind,
    outcome: 'error',
    replayedMessages: 0,
    replayHadCodeword: false,
    reportedCwd: null,
    survivesSecondRestart: null,
  }

  // 1. Seed a session in the origin directory, then kill that process. A seed
  // turn that did not answer (an auth or model error rendered as text) makes the
  // trial inconclusive — scoring it `forgot` would blame the session store.
  let sessionId: string
  try {
    const seed = await connect(config, config.originCwd, createTransport)
    try {
      const created = await seed.agent.request(methods.agent.session.new, {
        cwd: config.originCwd,
        mcpServers: [],
      })
      sessionId = created.sessionId
      await pinModel(seed, sessionId, created, modelHint)
      const reply = await ask(seed, sessionId, seedPrompt(codeword), turnTimeoutMs)
      if (!/\bOK\b/i.test(reply)) {
        return { ...trial, error: `seed turn did not acknowledge: ${reply.slice(0, 200)}` }
      }
    } finally {
      seed.dispose()
    }
  } catch (err) {
    return { ...trial, error: `seeding failed: ${acpProbeErrorMessage(err)}` }
  }

  // 2. A fresh process in the target directory reattaches and is asked back.
  type Recall =
    | { kind: 'rejected'; error: string }
    | {
        kind: 'answered'
        answer: string
        replayedMessages: number
        replayHadCodeword: boolean
      }
  const restartAndRecall = async (): Promise<Recall> => {
    const conn = await connect(config, target, createTransport)
    try {
      let replay
      let response
      try {
        ;({ replay, response } = await reattach(conn, method, sessionId, target))
      } catch (err) {
        return { kind: 'rejected', error: acpProbeErrorMessage(err) }
      }
      await pinModel(conn, sessionId, response, modelHint)
      const answer = await ask(conn, sessionId, RECALL_PROMPT, turnTimeoutMs)
      return {
        kind: 'answered',
        answer,
        replayedMessages: replay.length,
        replayHadCodeword: replay.some((update) => textOf(update).includes(codeword)),
      }
    } finally {
      conn.dispose()
    }
  }

  try {
    return await recallInto()
  } finally {
    if (canDelete) await deleteProbeSession(config, sessionId, createTransport)
  }

  async function recallInto(): Promise<AcpContinuityTrial> {
    try {
      const first = await restartAndRecall()
      if (first.kind === 'rejected') return { ...trial, outcome: 'rejected', error: first.error }
      trial.replayedMessages = first.replayedMessages
      trial.replayHadCodeword = first.replayHadCodeword
      trial.answerPreview = first.answer.slice(0, 200)
      trial.reportedCwd = classifyReportedCwd(first.answer, target, config.originCwd)
      if (first.answer.includes(codeword)) {
        trial.outcome = 'recalled'
      } else if (/\bUNKNOWN\b/.test(first.answer) || trial.reportedCwd !== null) {
        // It answered the question and did not know: memory, not the turn, failed.
        trial.outcome = 'forgot'
      } else {
        trial.error = 'recall turn did not answer the question'
        return trial
      }
      if (cwdKind === 'new' && trial.outcome === 'recalled') {
        const second = await restartAndRecall()
        trial.survivesSecondRestart = second.kind === 'answered' && second.answer.includes(codeword)
      }
    } catch (err) {
      trial.error = acpProbeErrorMessage(err)
    }
    return trial
  }
}

/**
 * Best effort: delete a probe session so the trials do not litter the agent's
 * own session history (Claude's `~/.claude/projects`, Codex's `~/.codex`) with
 * codeword conversations. A failed delete is ignored.
 */
async function deleteProbeSession(
  config: AcpContinuityProbeConfig,
  sessionId: string,
  createTransport: NonNullable<AcpContinuityProbeOptions['createTransport']>,
): Promise<void> {
  try {
    const conn = await connect(config, config.originCwd, createTransport)
    try {
      await conn.agent.request(methods.agent.session.delete, { sessionId })
    } finally {
      conn.dispose()
    }
  } catch {
    // Leaving a stray session behind is untidy, not a probe failure.
  }
}
