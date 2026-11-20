import type {} from './browser-globals.d.ts'
import { randomUUID } from 'node:crypto'
import { browser } from '@wdio/globals'
import { setComposerValue } from './composer.ts'
import type {
  MockResponse,
  MockScenario,
  mockScenarioStatus,
} from '../../../packages/llm/src/mock-script.ts'

type ScenarioStatus = ReturnType<typeof mockScenarioStatus>

export interface ScenarioBridge {
  setMockScenario(id: string, scenario: MockScenario, scope?: string): Promise<ScenarioStatus>
  mockScenarioStatus(id: string): Promise<ScenarioStatus>
  releaseMockScenario(id: string, hold: string): Promise<void>
  assertMockScenarioComplete(id: string): Promise<void>
  clearMockScenarios(): Promise<void>
  setVncNearbyServers(servers: unknown): Promise<void>
  pushErrorToast(message: string): void
  getErrorToasts(): string[]
  requestSshPrompt(prompt: string, kind: 'confirm' | 'secret'): Promise<unknown>
  requestCloseConfirm(): Promise<boolean>
  createMainWindow(): Promise<void>
  markQuit(): Promise<void>
  openWorkspace(root: string): Promise<unknown>
  requestAcpPackageInstallApproval(scenario?: 'install' | 'upgrade' | 'mixed'): Promise<unknown>
  requestRemoteWatcherInstallApproval(): Promise<unknown>
  emitAgentChunks(threadId: string, chunks: unknown[]): Promise<void>
  emitApprovalRequests(requests: unknown): Promise<void>
  cancelApprovalRequest(id: string): Promise<void>
  setSemanticIndexScaleGuard(phase: 'limited' | 'skipped', reason: string): Promise<void>
  setPortRows(rows: unknown): Promise<void>
  setSimulatorDesktop(value: unknown): Promise<void>
  showSimulatorDesktop(udid: string): Promise<void>
}

export interface ScenarioHandle {
  release(hold: string): Promise<void>
  waitForHold(hold: string, timeoutMs?: number): Promise<void>
  /** Wait for every scripted response to be consumed, whichever thread is selected. */
  waitForComplete(timeoutMs?: number): Promise<void>
  /** Wait until the first `count` scripted user turns have finished. */
  waitForTurns(count: number, timeoutMs?: number): Promise<void>
  assertComplete(): Promise<void>
  /** Where the scripted conversation is, for failure output. */
  status(): Promise<ScenarioStatus>
}

const installed: string[] = []
const verified = new Set<string>()

/**
 * What the transcript shows right now: the last assistant text, every tool card
 * that has not finished cleanly, and any scripted-model failure. Failure
 * artifacts are not always reachable, so a timed-out wait prints this to the
 * job log instead of only naming the text it expected.
 */
export async function describeTranscript(): Promise<string> {
  const state = await browser.execute(() => {
    const replies = document.querySelectorAll<HTMLElement>('.msg-assistant .message-text')
    const last = replies.length > 0 ? replies.item(replies.length - 1).innerText.trim() : null
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>('.messages-list [data-tool-id][data-status]'),
    ).map((card) => ({
      name: card.querySelector('.tool-name')?.textContent.trim() ?? '(unnamed)',
      status: card.dataset['status'] ?? '',
    }))
    const text = document.querySelector<HTMLElement>('.messages-list')?.innerText ?? ''
    const failures = text.split('\n').filter((line) => /mock scenario/i.test(line))
    // A collapsed card builds its body only when opened, so an error's message
    // is not in the DOM until then. Open each errored card the way a user
    // does, by clicking its header, and read what it shows.
    const errors = Array.from(
      document.querySelectorAll<HTMLDetailsElement>(
        '.messages-list details[data-tool-id][data-status="error"]',
      ),
    ).map((card) => {
      const summary = card.querySelector<HTMLElement>(':scope > summary')
      if (!card.open) summary?.click()
      const body = Array.from(card.children)
        .filter((child) => child !== summary)
        .map((child) => (child instanceof HTMLElement ? child.innerText : child.textContent))
        .join('\n')
        .trim()
      return {
        name: summary?.querySelector('.tool-name')?.textContent.trim() ?? '(unnamed)',
        body: body.slice(0, 2000),
      }
    })
    return { replies: replies.length, last, cards, failures, errors }
  })
  const unfinished = state.cards.filter((card) => card.status !== 'done')
  return [
    `assistant bubbles: ${String(state.replies)}; last text: ${JSON.stringify(state.last)}`,
    `tool cards: ${String(state.cards.length)} (${state.cards.map((c) => `${c.name}=${c.status}`).join(', ')})`,
    `unfinished tool cards: ${unfinished.length > 0 ? unfinished.map((c) => `${c.name}=${c.status}`).join(', ') : 'none'}`,
    `mock scenario messages: ${state.failures.length > 0 ? state.failures.join(' | ') : 'none'}`,
    ...state.errors.map((card) => `errored tool card ${card.name}: ${JSON.stringify(card.body)}`),
  ].join('\n')
}

/** Tool rounds can create empty assistant bubbles before the final text reply. */
export async function expectAssistantReply(text: string): Promise<void> {
  try {
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => {
          const replies = document.querySelectorAll<HTMLElement>('.msg-assistant .message-text')
          return replies.item(replies.length - 1).innerText.trim()
        })) === text,
      { timeout: 15_000, interval: 100, timeoutMsg: `Expected assistant reply: ${text}` },
    )
  } catch (error) {
    const detail = await describeTranscript().catch(
      (cause: unknown) =>
        `transcript unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    // stdout reaches the CI job log even when the artifact upload cannot be read.
    console.log(`[expectAssistantReply] ${text}\n${detail}`)
    throw new Error(`Expected assistant reply: ${text}\n${detail}`, { cause: error })
  }
}

/**
 * Keep model controls out of the composer. Bind to the selected thread, or let
 * the first exact user request bind a newly created thread to this scenario.
 */
export async function installMockScenario(
  scenario: MockScenario,
  scopeOverride?: string | null,
): Promise<ScenarioHandle> {
  // The composer mounts before project restoration finishes. Binding or typing
  // earlier can target the temporary thread whose draft restoration replaces.
  if (scopeOverride === undefined) {
    await browser.$('.chat-row.selected').waitForExist({ timeout: 30_000 })
  }
  const id = randomUUID()
  await browser.execute(
    async (registration) => {
      const bridge = window.__copseE2e
      if (!bridge) throw new Error('The test scenario bridge is unavailable')
      const scope =
        registration.scopeOverride === null
          ? undefined
          : (registration.scopeOverride ??
            document.querySelector<HTMLElement>('.chat-row.selected')?.dataset['threadId'])
      await bridge.setMockScenario(registration.id, registration.scenario, scope)
    },
    { id, scenario, scopeOverride },
  )
  installed.push(id)

  return {
    async release(hold): Promise<void> {
      await browser.execute(
        async ({ scenarioId, name }) => {
          const bridge = window.__copseE2e
          if (!bridge) throw new Error('The test scenario bridge is unavailable')
          await bridge.releaseMockScenario(scenarioId, name)
        },
        { scenarioId: id, name: hold },
      )
    },
    async waitForHold(hold, timeoutMs = 30_000): Promise<void> {
      await browser.waitUntil(
        async () => {
          const status = await browser.execute(async (scenarioId) => {
            const bridge = window.__copseE2e
            if (!bridge) throw new Error('The test scenario bridge is unavailable')
            return bridge.mockScenarioStatus(scenarioId)
          }, id)
          if (status.errors.length > 0) throw new Error(status.errors.join('\n'))
          return status.waitingFor === hold
        },
        { timeout: timeoutMs, interval: 50, timeoutMsg: `Scenario did not reach hold: ${hold}` },
      )
    },
    async waitForComplete(timeoutMs = 25_000): Promise<void> {
      await browser.waitUntil(
        async () => {
          const status = await browser.execute(async (scenarioId) => {
            const bridge = window.__copseE2e
            if (!bridge) throw new Error('The test scenario bridge is unavailable')
            return bridge.mockScenarioStatus(scenarioId)
          }, id)
          if (status.errors.length > 0) throw new Error(status.errors.join('\n'))
          return status.complete
        },
        {
          timeout: timeoutMs,
          interval: 50,
          timeoutMsg: 'The conversation scenario did not finish',
        },
      )
    },
    async waitForTurns(count, timeoutMs = 25_000): Promise<void> {
      await browser.waitUntil(
        async () => {
          const status = await browser.execute(async (scenarioId) => {
            const bridge = window.__copseE2e
            if (!bridge) throw new Error('The test scenario bridge is unavailable')
            return bridge.mockScenarioStatus(scenarioId)
          }, id)
          if (status.errors.length > 0) throw new Error(status.errors.join('\n'))
          return status.turn >= count
        },
        {
          timeout: timeoutMs,
          interval: 50,
          timeoutMsg: `The conversation scenario did not finish ${String(count)} turn(s)`,
        },
      )
    },
    async assertComplete(): Promise<void> {
      await browser.execute(async (scenarioId) => {
        const bridge = window.__copseE2e
        if (!bridge) throw new Error('The test scenario bridge is unavailable')
        await bridge.assertMockScenarioComplete(scenarioId)
      }, id)
      verified.add(id)
    },
    async status(): Promise<ScenarioStatus> {
      return browser.execute(async (scenarioId) => {
        const bridge = window.__copseE2e
        if (!bridge) throw new Error('The test scenario bridge is unavailable')
        return bridge.mockScenarioStatus(scenarioId)
      }, id)
    },
  }
}

// An unconsumed fixture must fail even if the UI happened to satisfy a weaker
// assertion. Always clear registrations between tests, including failed runs.
afterEach(async function () {
  if (installed.length === 0) return
  // Tests that restart Electron can verify completion before its in-memory
  // registrations disappear. Unverified scenarios must still finish here.
  const ids = installed.splice(0).filter((id) => !verified.has(id))
  verified.clear()
  const check = this.currentTest?.state === 'passed'
  if (check) {
    await browser.waitUntil(
      async () =>
        browser.execute(async (scenarioIds) => {
          const bridge = window.__copseE2e
          if (!bridge) throw new Error('The test scenario bridge is unavailable')
          const statuses = await Promise.all(scenarioIds.map((id) => bridge.mockScenarioStatus(id)))
          const errors = statuses.flatMap((status) => status.errors)
          if (errors.length) throw new Error(errors.join('\n'))
          return statuses.every((status) => status.complete)
        }, ids),
      { timeout: 15_000, interval: 50, timeoutMsg: 'The conversation scenario did not finish' },
    )
  }
  await browser.execute(
    async ({ scenarioIds, checkComplete }) => {
      const bridge = window.__copseE2e
      if (!bridge) throw new Error('The test scenario bridge is unavailable')
      try {
        if (checkComplete) {
          for (const id of scenarioIds) await bridge.assertMockScenarioComplete(id)
        }
      } finally {
        await bridge.clearMockScenarios()
      }
    },
    { scenarioIds: ids, checkComplete: check },
  )
})

/** Register one natural request and fill the composer without submitting it. */
export async function prepareMockTurn(
  user: string,
  responses: MockResponse[],
  allowAbort = false,
): Promise<ScenarioHandle> {
  const scenario = await installMockScenario({
    title: user.replace(/[.!?]$/, ''),
    turns: [{ user, responses, allowAbort }],
  })
  await setComposerValue(user)
  return scenario
}

/** Run a real tool, then render the fixture reply after its result arrives. */
export async function prepareMockToolTurn(
  user: string,
  tool: { name: string; args: Record<string, unknown> },
  reply: string,
  allowAbort = false,
): Promise<ScenarioHandle> {
  return prepareMockTurn(
    user,
    [{ toolCalls: [tool] }, { text: reply, expectToolResults: [{ name: tool.name }] }],
    allowAbort,
  )
}
