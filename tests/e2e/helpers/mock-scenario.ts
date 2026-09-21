import { randomUUID } from 'node:crypto'
import { browser } from '@wdio/globals'
import { setComposerValue } from './composer.ts'
import type {
  MockResponse,
  MockScenario,
  mockScenarioStatus,
} from '../../../packages/llm/src/mock-script.ts'

type ScenarioStatus = ReturnType<typeof mockScenarioStatus>

interface ScenarioBridge {
  setMockScenario(id: string, scenario: MockScenario, scope?: string): Promise<ScenarioStatus>
  mockScenarioStatus(id: string): Promise<ScenarioStatus>
  releaseMockScenario(id: string, hold: string): Promise<void>
  assertMockScenarioComplete(id: string): Promise<void>
  clearMockScenarios(): Promise<void>
}

declare global {
  interface Window {
    __copseE2e?: ScenarioBridge
  }
}

export interface ScenarioHandle {
  release(hold: string): Promise<void>
  waitForHold(hold: string): Promise<void>
  assertComplete(): Promise<void>
}

const installed: string[] = []
const verified = new Set<string>()

/** Tool rounds can create empty assistant bubbles before the final text reply. */
export async function expectAssistantReply(text: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => {
        const replies = document.querySelectorAll<HTMLElement>('.msg-assistant .message-text')
        return replies.item(replies.length - 1)?.innerText.trim() ?? ''
      })) === text,
    { timeout: 15_000, interval: 100, timeoutMsg: `Expected assistant reply: ${text}` },
  )
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
            document.querySelector<HTMLElement>('.chat-row.selected')?.dataset.threadId)
      await bridge.setMockScenario(registration.id, registration.scenario, scope)
    },
    { id, scenario, scopeOverride },
  )
  installed.push(id)

  return {
    async release(hold) {
      await browser.execute(
        async ({ scenarioId, name }) => {
          const bridge = window.__copseE2e
          if (!bridge) throw new Error('The test scenario bridge is unavailable')
          await bridge.releaseMockScenario(scenarioId, name)
        },
        { scenarioId: id, name: hold },
      )
    },
    async waitForHold(hold) {
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
        { timeout: 30_000, interval: 50, timeoutMsg: `Scenario did not reach hold: ${hold}` },
      )
    },
    async assertComplete() {
      await browser.execute(async (scenarioId) => {
        const bridge = window.__copseE2e
        if (!bridge) throw new Error('The test scenario bridge is unavailable')
        await bridge.assertMockScenarioComplete(scenarioId)
      }, id)
      verified.add(id)
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
