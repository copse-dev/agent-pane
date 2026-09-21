import { isRecord } from '@copse/std/unknown-value.ts'
import type { LLMTool, ToolResult } from './wire-types.ts'

export interface MockScenario {
  title: string
  turns: MockTurn[]
}

export interface MockTurn {
  user: string | { includes: string }
  responses: MockResponse[]
  allowAbort?: boolean
}

export interface MockResponse {
  text?: string
  reasoning?: string
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
  waitFor?: string
  expectToolResults?: Array<{ name: string; includes?: string }>
  chunkDelayMs?: number
  promptProgress?: number
  delayMs?: number
  continueTurn?: boolean
}

interface PendingToolCall {
  id: string
  name: string
}

interface ScenarioState {
  id: string
  scenario: MockScenario
  scope: string | null
  turn: number
  response: number
  pendingToolCalls: PendingToolCall[]
  active: boolean
  waitingFor: string | null
  cancelledTurns: number
  errors: string[]
  releases: Set<string>
  releaseWaiters: Map<string, (released: boolean) => void>
  activeUserTurnIdentity: string | null
  lastCompletedUserTurnIdentity: string | null
}

export interface MockScenarioResponseLease {
  response: MockResponse
  waitForRelease(signal?: AbortSignal): Promise<boolean>
  complete(toolCallIds: readonly string[]): void
  abort(): void
}

const MAX_TURNS = 64
const MAX_RESPONSES_PER_TURN = 32
const MAX_TOOL_CALLS = 32
const MAX_TEXT_LENGTH = 100_000
const MAX_HOLD_MS = 30_000

const scenarios = new Map<string, ScenarioState>()
const scopedScenarioIds = new Map<string, string>()

function fail(path: string, message: string): never {
  throw new Error(`Invalid mock scenario: ${path} ${message}`)
}

function parseString(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string') fail(path, 'must be a string')
  if (!allowEmpty && value.length === 0) fail(path, 'must not be empty')
  if (value.length > MAX_TEXT_LENGTH)
    fail(path, `must be at most ${String(MAX_TEXT_LENGTH)} characters`)
  return value
}

function parseArgs(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path, 'must be an object')
  return { ...value }
}

function unexpectedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(path, `has an unknown property ${JSON.stringify(key)}`)
  }
}

function parseResponse(value: unknown, path: string): MockResponse {
  if (!isRecord(value)) fail(path, 'must be an object')
  unexpectedKeys(
    value,
    [
      'text',
      'reasoning',
      'toolCalls',
      'waitFor',
      'expectToolResults',
      'chunkDelayMs',
      'promptProgress',
      'delayMs',
      'continueTurn',
    ],
    path,
  )
  const text =
    value['text'] === undefined ? undefined : parseString(value['text'], `${path}.text`, true)
  const reasoning =
    value['reasoning'] === undefined
      ? undefined
      : parseString(value['reasoning'], `${path}.reasoning`, true)
  const waitFor =
    value['waitFor'] === undefined ? undefined : parseString(value['waitFor'], `${path}.waitFor`)

  let toolCalls: Array<{ name: string; args: Record<string, unknown> }> | undefined
  if (value['toolCalls'] !== undefined) {
    if (!Array.isArray(value['toolCalls']) || value['toolCalls'].length === 0) {
      fail(`${path}.toolCalls`, 'must be a non-empty array')
    }
    if (value['toolCalls'].length > MAX_TOOL_CALLS) {
      fail(`${path}.toolCalls`, `must contain at most ${String(MAX_TOOL_CALLS)} calls`)
    }
    toolCalls = value['toolCalls'].map((call, index) => {
      const callPath = `${path}.toolCalls[${String(index)}]`
      if (!isRecord(call)) fail(callPath, 'must be an object')
      unexpectedKeys(call, ['name', 'args'], callPath)
      return {
        name: parseString(call['name'], `${callPath}.name`),
        args: parseArgs(call['args'], `${callPath}.args`),
      }
    })
  }

  let expectToolResults: Array<{ name: string; includes?: string }> | undefined
  if (value['expectToolResults'] !== undefined) {
    if (!Array.isArray(value['expectToolResults']) || value['expectToolResults'].length === 0) {
      fail(`${path}.expectToolResults`, 'must be a non-empty array')
    }
    if (value['expectToolResults'].length > MAX_TOOL_CALLS) {
      fail(`${path}.expectToolResults`, `must contain at most ${String(MAX_TOOL_CALLS)} results`)
    }
    expectToolResults = value['expectToolResults'].map((result, index) => {
      const resultPath = `${path}.expectToolResults[${String(index)}]`
      if (!isRecord(result)) fail(resultPath, 'must be an object')
      unexpectedKeys(result, ['name', 'includes'], resultPath)
      const includes =
        result['includes'] === undefined
          ? undefined
          : parseString(result['includes'], `${resultPath}.includes`, true)
      return {
        name: parseString(result['name'], `${resultPath}.name`),
        ...(includes === undefined ? {} : { includes }),
      }
    })
  }

  const promptProgress = value['promptProgress']
  if (
    promptProgress !== undefined &&
    (typeof promptProgress !== 'number' ||
      !Number.isFinite(promptProgress) ||
      promptProgress < 0 ||
      promptProgress > 1)
  )
    fail(`${path}.promptProgress`, 'must be a fraction from 0 to 1')
  const delayMs = value['delayMs']
  if (
    delayMs !== undefined &&
    (typeof delayMs !== 'number' ||
      !Number.isSafeInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > MAX_HOLD_MS)
  )
    fail(`${path}.delayMs`, 'must be a bounded non-negative delay')
  const continueTurn = value['continueTurn']
  if (continueTurn !== undefined && typeof continueTurn !== 'boolean')
    fail(`${path}.continueTurn`, 'must be a boolean')
  let chunkDelayMs: number | undefined
  if (value['chunkDelayMs'] !== undefined) {
    if (
      typeof value['chunkDelayMs'] !== 'number' ||
      !Number.isSafeInteger(value['chunkDelayMs']) ||
      value['chunkDelayMs'] < 0 ||
      value['chunkDelayMs'] > MAX_HOLD_MS
    ) {
      fail(`${path}.chunkDelayMs`, `must be an integer from 0 to ${String(MAX_HOLD_MS)}`)
    }
    chunkDelayMs = value['chunkDelayMs']
  }
  if (
    text === undefined &&
    reasoning === undefined &&
    toolCalls === undefined &&
    waitFor === undefined
  ) {
    fail(path, 'must emit text, reasoning, toolCalls, or waitFor')
  }
  return {
    ...(promptProgress === undefined ? {} : { promptProgress }),
    ...(delayMs === undefined ? {} : { delayMs }),
    ...(continueTurn === undefined ? {} : { continueTurn }),
    ...(text === undefined ? {} : { text }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(waitFor === undefined ? {} : { waitFor }),
    ...(expectToolResults === undefined ? {} : { expectToolResults }),
    ...(chunkDelayMs === undefined ? {} : { chunkDelayMs }),
  }
}

/** Parse external scenario data at the IPC/benchmark boundary. */
export function parseMockScenario(input: unknown): MockScenario {
  if (!isRecord(input)) fail('scenario', 'must be an object')
  unexpectedKeys(input, ['title', 'turns'], 'scenario')
  const title = parseString(input['title'], 'scenario.title')
  const rawTurns = input['turns']
  if (!Array.isArray(rawTurns) || rawTurns.length === 0)
    fail('scenario.turns', 'must be a non-empty array')
  if (rawTurns.length > MAX_TURNS)
    fail('scenario.turns', `must contain at most ${String(MAX_TURNS)} turns`)
  const turns = rawTurns.map((turn, turnIndex) => {
    const path = `scenario.turns[${String(turnIndex)}]`
    if (!isRecord(turn)) fail(path, 'must be an object')
    unexpectedKeys(turn, ['user', 'responses', 'allowAbort'], path)
    const rawUser = turn['user']
    const user = isRecord(rawUser)
      ? { includes: parseString(rawUser['includes'], `${path}.user.includes`) }
      : parseString(rawUser, `${path}.user`, true)
    if (isRecord(rawUser)) unexpectedKeys(rawUser, ['includes'], `${path}.user`)
    if (!Array.isArray(turn['responses']) || turn['responses'].length === 0)
      fail(`${path}.responses`, 'must be a non-empty array')
    if (turn['responses'].length > MAX_RESPONSES_PER_TURN)
      fail(`${path}.responses`, `must contain at most ${String(MAX_RESPONSES_PER_TURN)} responses`)
    if (turn['allowAbort'] !== undefined && typeof turn['allowAbort'] !== 'boolean')
      fail(`${path}.allowAbort`, 'must be a boolean')
    const responses = turn['responses'].map((response, responseIndex) =>
      parseResponse(response, `${path}.responses[${String(responseIndex)}]`),
    )
    for (let responseIndex = 0; responseIndex < responses.length; responseIndex++) {
      const response = responses[responseIndex]
      if (response === undefined) continue
      const previous = responseIndex === 0 ? undefined : responses[responseIndex - 1]
      if (
        responseIndex < responses.length - 1 &&
        response.toolCalls === undefined &&
        !response.continueTurn
      )
        fail(
          `${path}.responses[${String(responseIndex)}]`,
          'must call a tool before another response in the same user turn',
        )
      if (
        responseIndex === responses.length - 1 &&
        (response.toolCalls !== undefined || response.continueTurn)
      )
        fail(
          `${path}.responses[${String(responseIndex)}]`,
          'must finish the user turn with a non-tool response',
        )
      if (response.expectToolResults !== undefined && previous?.toolCalls === undefined)
        fail(
          `${path}.responses[${String(responseIndex)}].expectToolResults`,
          'requires tool calls from the previous response',
        )
    }
    return { user, responses, ...(turn['allowAbort'] === true ? { allowAbort: true } : {}) }
  })
  return { title, turns }
}

function recordError(state: ScenarioState, message: string): Error {
  state.errors.push(message)
  return new Error(`Mock scenario ${JSON.stringify(state.id)}: ${message}`)
}

function stateFor(id: string): ScenarioState {
  const state = scenarios.get(id)
  if (!state) throw new Error(`Mock scenario ${JSON.stringify(id)} is not registered`)
  return state
}

function isComplete(state: ScenarioState): boolean {
  return state.turn === state.scenario.turns.length && state.errors.length === 0
}

/** Register a scenario. Scoped registrations are immediately bound to their provider scope. */
export function setMockScenario(id: string, scenario: MockScenario, scope?: string): void {
  if (typeof id !== 'string' || id.length === 0)
    throw new Error('Mock scenario id must be a non-empty string')
  if (scope !== undefined && (typeof scope !== 'string' || scope.length === 0))
    throw new Error('Mock scenario scope must be a non-empty string when provided')
  const parsed = parseMockScenario(scenario)
  if (scope !== undefined) {
    const existingId = scopedScenarioIds.get(scope)
    if (existingId !== undefined) {
      const existing = stateFor(existingId)
      if (!isComplete(existing))
        throw new Error(
          `Mock scenario scope ${JSON.stringify(scope)} is still running ${JSON.stringify(existingId)}`,
        )
    }
  }
  const existing = scenarios.get(id)
  if (existing && !isComplete(existing))
    throw new Error(`Mock scenario ${JSON.stringify(id)} is still running`)
  if (existing?.scope !== null && existing !== undefined) scopedScenarioIds.delete(existing.scope)
  const state: ScenarioState = {
    id,
    scenario: parsed,
    scope: scope ?? null,
    turn: 0,
    response: 0,
    pendingToolCalls: [],
    active: false,
    waitingFor: null,
    cancelledTurns: 0,
    errors: [],
    releases: new Set(),
    releaseWaiters: new Map(),
    activeUserTurnIdentity: null,
    lastCompletedUserTurnIdentity: null,
  }
  scenarios.set(id, state)
  if (scope !== undefined) scopedScenarioIds.set(scope, id)
}

export function clearMockScenarios(): void {
  for (const state of scenarios.values()) {
    for (const release of state.releaseWaiters.values()) release(false)
  }
  scenarios.clear()
  scopedScenarioIds.clear()
}

export function releaseMockScenario(id: string, hold: string): void {
  const state = stateFor(id)
  if (typeof hold !== 'string' || hold.length === 0)
    throw new Error('Mock scenario hold must be a non-empty string')
  state.releases.add(hold)
  state.releaseWaiters.get(hold)?.(true)
}

export function mockScenarioStatus(id: string): {
  complete: boolean
  turn: number
  response: number
  waitingFor: string | null
  cancelledTurns: number
  errors: string[]
} {
  const state = stateFor(id)
  return {
    complete: isComplete(state),
    turn: state.turn,
    response: state.response,
    waitingFor: state.waitingFor,
    cancelledTurns: state.cancelledTurns,
    errors: [...state.errors],
  }
}

export function assertMockScenarioComplete(id: string): void {
  const state = stateFor(id)
  if (state.errors.length > 0)
    throw new Error(`Mock scenario ${JSON.stringify(id)} failed: ${state.errors.join('; ')}`)
  if (!isComplete(state))
    throw new Error(
      `Mock scenario ${JSON.stringify(id)} is incomplete at turn ${String(state.turn)}, response ${String(state.response)}`,
    )
}

/** Return a fixture title for an expected prompt without consuming scenario state. */
export function mockScenarioTitle(userText: string): string | null {
  for (const state of scenarios.values())
    if (
      state.scenario.turns.some(
        (turn) => typeof turn.user === 'string' && userText.includes(turn.user),
      )
    )
      return state.scenario.title
  return null
}

function matchesUser(expected: MockTurn['user'] | undefined, actual: string): boolean {
  return typeof expected === 'string'
    ? expected === actual
    : expected !== undefined && actual.includes(expected.includes)
}

function findPendingScenario(scope: string, userText: string): ScenarioState | null {
  const matches = [...scenarios.values()].filter(
    (state) =>
      state.scope === null &&
      state.turn === 0 &&
      matchesUser(state.scenario.turns[0]?.user, userText),
  )
  if (matches.length === 0) return null
  if (matches.length > 1)
    throw new Error(
      `Multiple pending mock scenarios match scoped request ${JSON.stringify(scope)}; register one with an explicit scope`,
    )
  const state = matches[0]
  if (!state) return null
  state.scope = scope
  scopedScenarioIds.set(scope, state.id)
  return state
}

function validatePendingToolResults(
  state: ScenarioState,
  response: MockResponse,
  results: readonly ToolResult[],
): void {
  if (state.pendingToolCalls.length === 0) return
  const pendingById = new Map(state.pendingToolCalls.map((call) => [call.id, call]))
  const actual = results.filter((result) => pendingById.has(result.toolCallId))
  if (actual.length !== state.pendingToolCalls.length)
    throw recordError(
      state,
      `expected ${String(state.pendingToolCalls.length)} tool result(s) before response ${String(state.response)}, received ${String(actual.length)}`,
    )
  for (const pending of state.pendingToolCalls)
    if (!actual.some((result) => result.toolCallId === pending.id))
      throw recordError(state, `missing tool result for ${JSON.stringify(pending.name)}`)
  const expected = response.expectToolResults
  if (expected !== undefined) {
    if (expected.length !== actual.length)
      throw recordError(
        state,
        `expected ${String(expected.length)} checked tool result(s), received ${String(actual.length)}`,
      )
    for (let index = 0; index < expected.length; index++) {
      const expectedResult = expected[index]
      const actualResult = actual[index]
      if (expectedResult === undefined || actualResult === undefined) continue
      const pending = pendingById.get(actualResult.toolCallId)
      if (pending?.name !== expectedResult.name)
        throw recordError(
          state,
          `expected tool result ${String(index + 1)} from ${JSON.stringify(expectedResult.name)}, received ${JSON.stringify(pending?.name ?? 'unknown')}`,
        )
      if (
        expectedResult.includes !== undefined &&
        !actualResult.result.includes(expectedResult.includes)
      )
        throw recordError(
          state,
          `tool result from ${JSON.stringify(expectedResult.name)} did not include ${JSON.stringify(expectedResult.includes)}`,
        )
    }
  }
  state.pendingToolCalls = []
}

function advanceAfterResponse(state: ScenarioState, toolCallIds: readonly string[]): void {
  const turn = state.scenario.turns[state.turn]
  const response = turn?.responses[state.response]
  if (!turn || !response)
    throw recordError(state, 'internal cursor points beyond the configured conversation')
  if ((response.toolCalls?.length ?? 0) !== toolCallIds.length)
    throw recordError(
      state,
      'provider emitted a different number of tool calls than the scenario configured',
    )
  if (response.toolCalls !== undefined) {
    state.pendingToolCalls = response.toolCalls.map((toolCall, index) => {
      const id = toolCallIds[index]
      if (id === undefined) throw recordError(state, 'provider did not assign a tool call id')
      return { id, name: toolCall.name }
    })
    state.response++
  } else if (response.continueTurn) {
    state.response++
  } else {
    state.lastCompletedUserTurnIdentity = state.activeUserTurnIdentity
    state.activeUserTurnIdentity = null
    state.turn++
    state.response = 0
  }
  state.active = false
  state.waitingFor = null
}

function abortResponse(state: ScenarioState): void {
  const turn = state.scenario.turns[state.turn]
  state.active = false
  state.waitingFor = null
  if (turn?.allowAbort === true) {
    state.lastCompletedUserTurnIdentity = state.activeUserTurnIdentity
    state.activeUserTurnIdentity = null
    state.turn++
    state.response = 0
    state.pendingToolCalls = []
    state.cancelledTurns++
    return
  }
  recordError(state, `turn ${String(state.turn)} was aborted without allowAbort: true`)
}

async function waitForHold(
  state: ScenarioState,
  hold: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (state.releases.delete(hold)) return true
  state.waitingFor = hold
  return new Promise<boolean>((resolve) => {
    let settled = false
    const settle = (released: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      state.releaseWaiters.delete(hold)
      if (released) state.releases.delete(hold)
      state.waitingFor = null
      resolve(released)
    }
    const onAbort = (): void => {
      settle(false)
    }
    const timeout = setTimeout(() => {
      recordError(state, `hold ${JSON.stringify(hold)} timed out after ${String(MAX_HOLD_MS)}ms`)
      settle(false)
    }, MAX_HOLD_MS)
    state.releaseWaiters.set(hold, settle)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

/** Claim the next scripted provider response for a scope. MockLLMProvider owns streaming; this module owns state. */
export function claimMockScenarioResponse(
  scope: string | undefined,
  userText: string,
  userTurnIdentity: string,
  tools: readonly LLMTool[],
  toolResults: readonly ToolResult[],
): MockScenarioResponseLease | null {
  if (scope === undefined) return null
  const boundId = scopedScenarioIds.get(scope)
  const state = boundId === undefined ? findPendingScenario(scope, userText) : stateFor(boundId)
  if (!state) return null
  if (state.errors.length > 0)
    throw recordError(state, 'received another request after an earlier failure')
  if (isComplete(state))
    throw recordError(state, 'received an unexpected request after the conversation completed')
  if (state.active)
    throw recordError(state, 'received a concurrent request while the previous response is active')
  const turn = state.scenario.turns[state.turn]
  const response = turn?.responses[state.response]
  if (!turn || !response) throw recordError(state, 'has no response configured for this request')
  if (state.pendingToolCalls.length === 0) {
    if (!matchesUser(turn.user, userText))
      throw recordError(
        state,
        `expected user text ${JSON.stringify(turn.user)}, received ${JSON.stringify(userText)}`,
      )
    if (state.lastCompletedUserTurnIdentity === userTurnIdentity) {
      throw recordError(state, 'received the previous user turn again instead of a new user turn')
    }
    state.activeUserTurnIdentity = userTurnIdentity
  } else if (state.activeUserTurnIdentity !== userTurnIdentity) {
    throw recordError(state, 'tool continuation did not preserve the originating user turn')
  }
  validatePendingToolResults(state, response, toolResults)
  for (const toolCall of response.toolCalls ?? [])
    if (!tools.some((tool) => tool.name === toolCall.name))
      throw recordError(
        state,
        `tool ${JSON.stringify(toolCall.name)} is unavailable for this request`,
      )
  state.active = true
  const turnIndex = state.turn
  const abort = (): void => {
    if (state.turn === turnIndex) abortResponse(state)
  }
  return {
    response,
    waitForRelease: (signal?: AbortSignal): Promise<boolean> => {
      signal?.addEventListener('abort', abort, { once: true })
      return response.waitFor === undefined
        ? Promise.resolve(true)
        : waitForHold(state, response.waitFor, signal)
    },
    complete: (toolCallIds: readonly string[]): void => {
      advanceAfterResponse(state, toolCallIds)
    },
    abort: (): void => {
      abort()
    },
  }
}
