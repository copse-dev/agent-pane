import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type Stream,
} from '@agentclientprotocol/sdk'
import { z } from 'zod'

export interface AcpJudgeOptions {
  command: string
  args: string[]
  model?: string
  timeoutMs: number
}

interface AcpJudgeTransport {
  stream: Stream
  dispose: () => void
}

type TransportFactory = (options: AcpJudgeOptions, cwd: string) => AcpJudgeTransport

const choiceSchema = z.object({ value: z.string() })
const modelOptionSchema = z.object({
  id: z.string(),
  category: z.literal('model'),
  type: z.literal('select'),
  currentValue: z.string().min(1),
  options: z.array(z.union([choiceSchema, z.object({ options: z.array(choiceSchema) })])),
})
const usageSchema = z.object({ usage: z.record(z.string(), z.unknown()).optional() })

export interface AcpTextResult {
  text: string
  model: string | null
  usage: Record<string, number> | null
  latencyMs: number
  error: string | null
  acp?: {
    agentName: string | null
    agentVersion: string | null
    setupMs: number
    promptMs: number | null
    modelEvidence: string
    stopReason?: string
    outputCharacters?: number
  }
}

function spawnJudgeTransport(options: AcpJudgeOptions, cwd: string): AcpJudgeTransport {
  const child = spawn(options.command, options.args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  // Drain diagnostics without persisting credential-bearing provider errors.
  child.stderr.resume()
  let finished = false
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    if (child.pid && process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // The group may already have exited.
      }
    }
    child.kill('SIGKILL')
    child.stdin.destroy()
    child.stdout.destroy()
  }
  const readable = new ReadableStream<Uint8Array>({
    start(controller): void {
      const fail = (): void => {
        if (finished) return
        finished = true
        controller.error(new Error('ACP transport closed'))
      }
      child.stdout.on('data', (chunk: Buffer) => {
        if (!finished) controller.enqueue(new Uint8Array(chunk))
      })
      child.stdout.on('error', fail)
      child.stdin.on('error', fail)
      child.on('error', fail)
      child.on('close', fail)
    },
    cancel(): void {
      finished = true
      dispose()
    },
  })
  const writable = new WritableStream<Uint8Array>({
    write(chunk): Promise<void> {
      return new Promise((resolve, reject) => {
        child.stdin.write(chunk, (error) => {
          if (error) reject(new Error('ACP transport write failed'))
          else resolve()
        })
      })
    },
    close(): void {
      child.stdin.end()
    },
    abort(): void {
      dispose()
    },
  })
  return { stream: ndJsonStream(writable, readable), dispose }
}

/** One isolated process/session per case; never reuses earlier answers or labels. */
export async function evaluateAcpText(
  prompt: string,
  options: AcpJudgeOptions,
  createTransport: TransportFactory = spawnJudgeTransport,
): Promise<AcpTextResult> {
  const started = performance.now()
  let cwd: string | undefined
  let transport: AcpJudgeTransport | undefined
  let connection: ClientConnection | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const state: {
    timedOut: boolean
    cancelled: boolean
    toolsRequested: boolean
    sessionId: string | undefined
  } = {
    timedOut: false,
    cancelled: false,
    toolsRequested: false,
    sessionId: undefined,
  }
  let failure = 'ACP connection, authentication, or transport failed; verify the agent login'
  let selectedModel: string | null = null
  let details: AcpTextResult['acp']
  let usage: Record<string, number> | null = null
  const cancel = (): void => {
    state.cancelled = true
    failure = 'ACP evaluation cancelled'
    connection?.close()
    transport?.dispose()
  }
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
    cwd = await mkdtemp(join(tmpdir(), 'copse-judge-eval-'))
    if (state.cancelled) throw new Error(failure)
    transport = createTransport(options, cwd)
    let answer = ''
    const denyTool = (): never => {
      state.toolsRequested = true
      throw new Error('Tools are unavailable during judgment evaluation')
    }
    const app = client({ name: 'copse-judge-eval' })
      .onRequest(methods.client.fs.readTextFile, denyTool)
      .onRequest(methods.client.fs.writeTextFile, denyTool)
      .onRequest(methods.client.terminal.create, denyTool)
      .onRequest(methods.client.session.requestPermission, () => {
        state.toolsRequested = true
        return { outcome: { outcome: 'cancelled' as const } }
      })
      .onNotification(methods.client.session.update, (ctx) => {
        if (ctx.params.sessionId !== state.sessionId) return
        const update = ctx.params.update
        if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          state.toolsRequested = true
        }
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          answer += update.content.text
          if (answer.length > 16_384) {
            failure = 'ACP judgment exceeded the output limit'
            connection?.close()
          }
        }
      })
    connection = app.connect(transport.stream)
    timer = setTimeout(() => {
      state.timedOut = true
      connection?.close()
      transport?.dispose()
    }, options.timeoutMs)
    const initialized = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    const session = await connection.agent.request(methods.agent.session.new, {
      cwd,
      mcpServers: [],
    })
    const sessionId = session.sessionId
    state.sessionId = sessionId
    const selectors = (session.configOptions ?? []).flatMap((option) => {
      const parsed = modelOptionSchema.safeParse(option)
      return parsed.success ? [parsed.data] : []
    })
    const selector = selectors[0]
    if (!selector) {
      failure = 'ACP agent did not advertise a model selector; cannot identify the comparison model'
      throw new Error(failure)
    }
    selectedModel = options.model ?? selector.currentValue
    const choices = selector.options.flatMap((choice) =>
      'options' in choice ? choice.options : [choice],
    )
    if (!choices.some((choice) => choice.value === selectedModel)) {
      failure = 'ACP requested model is unavailable; choose an advertised model ID'
      throw new Error(failure)
    }
    if (selectedModel !== selector.currentValue) {
      failure = 'ACP model selection failed; no fallback model was used'
      const changed = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: selector.id,
        value: selectedModel,
      })
      const confirmed = changed.configOptions.some((option) => {
        const parsed = modelOptionSchema.safeParse(option)
        return (
          parsed.success &&
          parsed.data.id === selector.id &&
          parsed.data.currentValue === selectedModel
        )
      })
      if (!confirmed) throw new Error(failure)
    }
    const promptStarted = performance.now()
    details = {
      agentName: initialized.agentInfo?.name ?? null,
      agentVersion: initialized.agentInfo?.version ?? null,
      setupMs: promptStarted - started,
      promptMs: null,
      modelEvidence:
        'ACP session model selection; underlying served model not independently reported',
    }
    failure = 'ACP prompt failed; verify the agent login'
    const response = await connection.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        {
          type: 'text',
          text: prompt,
        },
      ],
    })
    details.promptMs = performance.now() - promptStarted
    details.stopReason = response.stopReason
    details.outputCharacters = answer.length
    const parsedUsage = usageSchema.safeParse(response)
    const numericUsage: Record<string, number> = {}
    if (parsedUsage.success && parsedUsage.data.usage) {
      for (const [key, value] of Object.entries(parsedUsage.data.usage)) {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
          numericUsage[key] = value
      }
    }
    usage = Object.keys(numericUsage).length > 0 ? numericUsage : null
    if (state.toolsRequested) {
      failure = 'ACP agent requested tools; this eval requires a text-only judgment'
      throw new Error(failure)
    }
    if (response.stopReason !== 'end_turn') {
      failure = 'ACP turn did not finish normally'
      throw new Error(failure)
    }
    return {
      text: answer,
      error: null,
      model: selectedModel,
      usage,
      latencyMs: performance.now() - started,
      acp: details,
    }
  } catch {
    return {
      text: '',
      model: selectedModel,
      usage,
      error: state.cancelled
        ? 'ACP evaluation cancelled'
        : state.timedOut
          ? 'ACP evaluation timed out'
          : failure,
      latencyMs: performance.now() - started,
      ...(details ? { acp: details } : {}),
    }
  } finally {
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
    if (timer) clearTimeout(timer)
    connection?.close()
    transport?.dispose()
    if (cwd) await rm(cwd, { recursive: true, force: true })
  }
}
