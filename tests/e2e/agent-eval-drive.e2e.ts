import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser } from '@wdio/globals'
import { threadToJsonl } from '../../src/renderer/export-thread.ts'
import type { Thread } from '@shared/types'
import { getCopseUserDataDir } from './helpers.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const ARTIFACTS = join(process.cwd(), 'tests/e2e/artifacts')
const DEFAULT_SCENARIO = join(process.cwd(), 'tests/e2e/scenarios/agent-eval.example.json')

interface EvalScenario {
  id: string
  description?: string
  prompts: string[]
}

function loadScenario(): EvalScenario {
  const path = process.env.COPSE_EVAL_SCENARIO?.trim() || DEFAULT_SCENARIO
  return JSON.parse(readFileSync(path, 'utf8')) as EvalScenario
}

/** macOS seatbelt prompts before `gh`, network, etc. Auto-approve so evals don't hang. */
async function approvePendingApprovalDialogs(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const open = await browser.execute(() => {
      const dialog = document.querySelector('#approval-dialog')
      return dialog instanceof HTMLDialogElement && dialog.open
    })
    if (!open) return
    await $('.approval-approve').click()
    await browser.pause(100)
  }
}

async function waitForAgentIdle(timeoutMs: number): Promise<void> {
  await browser.waitUntil(
    async () => {
      await approvePendingApprovalDialogs()
      return (await $('.submit-btn').getText()) === 'Stop'
    },
    {
      timeout: 60_000,
      interval: 100,
      timeoutMsg: 'Agent did not start (submit button Stop)',
    },
  )
  await browser.waitUntil(
    async () => {
      await approvePendingApprovalDialogs()
      return (await $('.submit-btn').getText()) === 'Send'
    },
    {
      timeout: timeoutMs,
      interval: 500,
      timeoutMsg: 'Agent did not return to idle (submit button Send)',
    },
  )
  await browser.waitUntil(
    async () => {
      const disabled = await $('.prompt-input').getProperty('disabled')
      return disabled !== true
    },
    { timeout: 30_000, interval: 200 },
  )
  await $('.msg-assistant').waitForExist({ timeout: 30_000 })
  // Autosave debounces thread writes (~250ms); give persistence a beat before export.
  await browser.pause(500)
}

function readActiveThread(): Thread {
  const configPath = join(getCopseUserDataDir(), 'config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  const projectId = config.activeProjectId as string
  const threads = config[`threads:${projectId}`] as Thread[]
  if (!Array.isArray(threads) || threads.length === 0) {
    throw new Error('No threads in config after eval run')
  }
  const activeId = config.activeThreadId as string | undefined
  const thread = threads.find((t) => t.id === activeId) ?? threads[threads.length - 1]
  if (!thread) throw new Error('Could not resolve active thread')
  return thread
}

describe('agent eval drive', () => {
  before(async () => {
    mkdirSync(ARTIFACTS, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'agent-eval-project', { subagentsEnabled: true })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('runs scenario prompts against the real agent and writes JSONL artifact', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const scenario = loadScenario()
    const idleTimeout = Number(process.env.COPSE_EVAL_IDLE_MS ?? 15 * 60_000)

    for (const prompt of scenario.prompts) {
      const textarea = await $('.prompt-input')
      await textarea.setValue(prompt)
      await $('.submit-btn').click()
      await waitForAgentIdle(idleTimeout)
    }

    const thread = readActiveThread()
    const body = threadToJsonl(thread)
    const outPath = join(ARTIFACTS, `${scenario.id}-${Date.now()}.jsonl`)
    writeFileSync(outPath, body, 'utf8')
    process.stdout.write(`\nCOPSE_EVAL_ARTIFACT=${outPath}\n`)
  })
})
