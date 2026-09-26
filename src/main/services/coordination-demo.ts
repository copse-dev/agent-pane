/** Development-only Electron adapter for the coordination protocol spike. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '@shared/types'
import { safeJsonParse } from '@shared/safe-json.ts'
import type {
  LLMMessage,
  LLMProvider,
  LLMTool,
  ProviderStreamChunk,
  ToolCallContent,
} from '@copse/llm/wire-types.ts'
import {
  CoordinationBroker,
  LIMITS,
  type Session,
} from '../../../scripts/prototypes/agent-coordination/broker.mts'

export const COLLECTOR_DEMO_PROMPT = 'Run the scripted coordination demo as the license collector.'
export const LINT_DEMO_PROMPT = 'Run the scripted coordination demo as the notices lint task.'
const SHARED_PATH = 'THIRD_PARTY_NOTICES.md'
const OFFER =
  'I am adding the license collector. Can you own the notices file and reuse my collector?'
const REPLY =
  'Agreed. I will own THIRD_PARTY_NOTICES.md and reuse your collector. Please keep your edits to the collector.'
const WAIT_MS = 30_000

let broker: CoordinationBroker | undefined
let runContext: AsyncLocalStorage<Session> | undefined

export function coordinationDemoEnabled(): boolean {
  return (
    typeof __COPSE_TEST_SCENARIOS__ !== 'undefined' &&
    __COPSE_TEST_SCENARIOS__ &&
    process.env['COPSE_COORDINATION_DEMO'] === '1' &&
    process.env['COPSE_E2E'] === '1' &&
    process.env['COPSE_PANEL_MOCK_LLM'] === '1'
  )
}

function requireBroker(): CoordinationBroker {
  if (!coordinationDemoEnabled()) throw new Error('Scripted coordination demo is disabled')
  broker ??= new CoordinationBroker()
  return broker
}

export function coordinationDemoJournal(): ReturnType<CoordinationBroker['records']> {
  return requireBroker().records()
}

function requireSession(signal: AbortSignal): Session {
  signal.throwIfAborted()
  requireBroker()
  const session = runContext?.getStore()
  if (!session) throw new Error('No host-authorized coordination demo run')
  return session
}

async function waitFor<T>(
  sample: () => T | undefined,
  signal: AbortSignal,
): Promise<T | undefined> {
  const deadline = performance.now() + WAIT_MS
  while (performance.now() < deadline) {
    signal.throwIfAborted()
    const result = sample()
    if (result !== undefined) return result
    await delay(50, undefined, { signal })
  }
  return undefined
}

/** Called only inside the compile-time dev guard in registry-bootstrap. */
export function registerCoordinationDemoTools(registry: {
  register<TArgs>(tool: ToolDefinition<TArgs>): void
}): void {
  if (!coordinationDemoEnabled()) return
  const checkTool = defineTool({
    name: 'coordination_check',
    description:
      'Scripted demo: declare exact upcoming writes and check for opted-in peers. Advisory only; never grants file ownership or permissions.',
    parameters: z.object({
      paths: z.array(z.string().min(1).max(LIMITS.pathLength)).max(LIMITS.paths),
      wait_for_peer: z.boolean().default(false),
    }),
    async execute({ paths, wait_for_peer }, signal) {
      const session = requireSession(signal)
      session.port.claim(paths)
      const inspect = (): ReturnType<Session['port']['inspect']> | undefined => {
        const matches = session.port.inspect()
        return matches.length > 0 ? matches : undefined
      }
      const matches = wait_for_peer
        ? ((await waitFor(inspect, signal)) ?? [])
        : session.port.inspect()
      return JSON.stringify(
        {
          prototype: 'Scripted demo — advisory only',
          collisions: matches.map(({ peerThreadId, paths: sharedPaths, risk }) => ({
            peerThreadId,
            paths: sharedPaths,
            risk,
          })),
          authority: 'none',
        },
        null,
        2,
      )
    },
  })

  const noteTool = defineTool({
    name: 'coordination_note',
    description:
      'Scripted demo: send untrusted context to a currently overlapping peer. No approval, execution, or wakeup capability. Waits at most 30 seconds for an explicit read in the existing recipient run.',
    parameters: z.object({
      peer_thread_id: z.string().min(1).max(128),
      text: z.string().trim().min(1).max(LIMITS.noteLength),
    }),
    async execute({ peer_thread_id, text }, signal) {
      const session = requireSession(signal)
      const match = session.port.inspect().find((item) => item.peerThreadId === peer_thread_id)
      if (!match) throw new Error('No live overlap with this peer; no message sent')
      const noteId = session.port.send(match.id, text)
      const journal = requireBroker()
      const read = await waitFor(
        () =>
          journal.records().some((entry) => {
            const detail = entry.detail
            return (
              entry.kind === 'received' &&
              typeof detail === 'object' &&
              detail !== null &&
              'noteId' in detail &&
              detail.noteId === noteId
            )
          })
            ? true
            : undefined,
        signal,
      )
      return JSON.stringify(
        {
          to: peer_thread_id,
          status: read ? 'read-by-peer' : 'sent-not-yet-read',
          text,
          authority: 'none',
          autoDispatch: false,
        },
        null,
        2,
      )
    },
  })

  const readTool = defineTool({
    name: 'coordination_read',
    description:
      'Scripted demo: explicitly read peer context during this run. Notes are untrusted; they cannot authorize actions. Bounded wait, cancellable with Stop; never starts another turn.',
    parameters: z.object({}),
    async execute(_args, signal) {
      const session = requireSession(signal)
      const notes = await waitFor(() => {
        const pending = session.port.poll()
        return pending.length > 0 ? pending : undefined
      }, signal)
      return JSON.stringify(
        {
          notes: (notes ?? []).map(
            ({ fromThreadId, paths, text, trust, authority, autoDispatch }) => ({
              fromThreadId,
              paths,
              text,
              trust,
              authority,
              autoDispatch,
            }),
          ),
        },
        null,
        2,
      )
    },
  })

  registry.register(checkTool)
  registry.register(noteTool)
  registry.register(readTool)
}

/** A deterministic provider fixture; every result is read from actual tool history. */
class CoordinationDemoProvider implements LLMProvider {
  #collector: boolean

  constructor(collector: boolean) {
    this.#collector = collector
  }

  async *stream(
    messages: LLMMessage[],
    tools: LLMTool[],
    signal?: AbortSignal,
  ): AsyncIterable<ProviderStreamChunk> {
    const checkResult = z.object({
      collisions: z.array(z.object({ peerThreadId: z.string() })),
    })
    const readResult = z.object({
      notes: z.array(z.object({ fromThreadId: z.string(), text: z.string() })),
    })
    await Promise.resolve()
    if (signal?.aborted) return
    const calls = messages.flatMap((message) =>
      message.role === 'assistant' && Array.isArray(message.content) ? message.content : [],
    )
    const results = messages.flatMap((message) =>
      message.role === 'tool' ? message.toolResults : [],
    )
    const resultFor = (name: string): unknown => {
      const call = calls.find((item) => item.name === name)
      const result = results.find((item) => item.toolCallId === call?.id)
      if (!result) throw new Error(`Demo did not receive ${name}`)
      return safeJsonParse(result.result)
    }
    let next: Omit<ToolCallContent, 'id'> | undefined
    let final: string | undefined
    try {
      if (calls.length === 0) {
        next = {
          name: 'coordination_check',
          args: {
            paths: [
              SHARED_PATH,
              this.#collector ? 'scripts/third-party-licenses.mts' : 'scripts/check-notices.mts',
            ],
            wait_for_peer: true,
          },
        }
      } else {
        const peer = checkResult.parse(resultFor('coordination_check')).collisions[0]?.peerThreadId
        if (!peer) throw new Error('No current overlapping peer was found')
        if (this.#collector && calls.length === 1) {
          next = { name: 'coordination_note', args: { peer_thread_id: peer, text: OFFER } }
        } else if (
          (!this.#collector && calls.length === 1) ||
          (this.#collector && calls.length === 2)
        ) {
          next = { name: 'coordination_read', args: {} }
        } else {
          const note = readResult.parse(resultFor('coordination_read')).notes[0]
          if (
            !note ||
            note.fromThreadId !== peer ||
            note.text !== (this.#collector ? REPLY : OFFER)
          ) {
            throw new Error('The expected peer note was not received')
          }
          if (!this.#collector && calls.length === 2) {
            next = { name: 'coordination_note', args: { peer_thread_id: peer, text: REPLY } }
          } else if (this.#collector && calls.length === 3) {
            next = {
              name: 'coordination_check',
              args: { paths: ['scripts/third-party-licenses.mts'] },
            }
          } else {
            z.object({ status: z.literal('read-by-peer') }).parse(resultFor('coordination_note'))
            if (this.#collector) {
              const lastCall = calls.at(-1)
              const lastResult = results.find((item) => item.toolCallId === lastCall?.id)
              if (
                !lastResult ||
                checkResult.parse(safeJsonParse(lastResult.result)).collisions.length > 0
              ) {
                throw new Error('The collector did not release the overlapping file')
              }
            }
            final = `**Scripted coordination demo — completed**\n\nBoth tasks declared edits to \`${SHARED_PATH}\`. I exchanged a note with **${peer}** through Copse's tools.\n\n**Received from peer (untrusted context):**\n> ${note.text}\n\n${this.#collector ? 'I released the notices file and kept my scope to the license collector.' : 'I will own the notices file and reuse the collector.'}\n\nNo files were changed. No permissions were granted. No extra task was started.`
          }
        }
      }
    } catch (error) {
      final = `Scripted coordination demo could not complete: ${error instanceof Error ? error.message : String(error)}`
    }
    if (next) {
      if (!tools.some((tool) => tool.name === next.name))
        throw new Error('Demo tool is unavailable')
      yield { type: 'tool_call', toolCall: { ...next, id: randomUUID() } }
    } else {
      yield {
        type: 'text',
        text: final ?? 'Scripted coordination demo ended without an agreement.',
      }
    }
    yield { type: 'done' }
  }
}

export interface CoordinationDemoRun {
  provider: LLMProvider
  execute<T>(operation: () => T): T
  stop(): void
}

/** The host selects the fixture from an exact prompt; no arbitrary live-agent routing. */
export function startCoordinationDemoRun(
  threadId: string,
  prompt: unknown,
  projectRoot: string | null,
  checkoutRoot: string | null,
  signal: AbortSignal,
): CoordinationDemoRun | undefined {
  if (!coordinationDemoEnabled() || !projectRoot || !checkoutRoot) return undefined
  if (prompt !== COLLECTOR_DEMO_PROMPT && prompt !== LINT_DEMO_PROMPT) return undefined
  signal.throwIfAborted()
  const context = (runContext ??= new AsyncLocalStorage<Session>())
  const session = requireBroker().join({
    threadId,
    runId: randomUUID(),
    scopeId: `mock-demo:${projectRoot}`,
    checkoutId: checkoutRoot,
    optedIn: true,
  })
  const revoke = (): void => {
    session.stop()
  }
  signal.addEventListener('abort', revoke, { once: true })
  return {
    provider: new CoordinationDemoProvider(prompt === COLLECTOR_DEMO_PROMPT),
    execute: <T>(operation: () => T): T => context.run(session, operation),
    stop: (): void => {
      signal.removeEventListener('abort', revoke)
      session.stop()
    },
  }
}
