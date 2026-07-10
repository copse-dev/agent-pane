import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { $, browser } from '@wdio/globals'
import { threadToJsonl } from '../../src/renderer/export-thread.ts'
import type { Thread } from '@shared/types'
import { getCopseUserDataDir, waitForAgentIdle, waitForPromptReady } from './helpers.ts'
import { DEFAULT_APP_CHAT_MODEL, LM_STUDIO_MODEL_IDS } from '../../src/shared/lm-studio-defaults.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'

const ARTIFACTS = join(process.cwd(), 'tests/e2e/artifacts')
const DEFAULT_SCENARIO = join(process.cwd(), 'tests/e2e/scenarios/agent-eval.example.json')

type PromptAttachment = {
  path: string
  content?: string
  fixture?: string
}

type EvalPrompt =
  | string
  | {
      text: string
      attachments?: PromptAttachment[]
    }

interface EvalScenario {
  id: string
  description?: string
  workspace?: {
    type: 'current' | 'tempProject'
    prefix?: string
  }
  prompts: EvalPrompt[]
  assertWorkspace?: {
    git?: {
      minCommits?: number
    }
    homePage?: {
      path?: string
      contains?: string[]
      linksTo?: string
    }
    menuPage?: {
      path?: string
      contains?: string[]
    }
    filesContain?: Array<{
      glob?: string
      contains: string[]
    }>
  }
}

function loadScenario(): EvalScenario {
  const path = process.env.COPSE_EVAL_SCENARIO?.trim() || DEFAULT_SCENARIO
  return JSON.parse(readFileSync(path, 'utf8')) as EvalScenario
}

function scenarioProjectRoot(scenario: EvalScenario): { root: string; cleanup?: () => void } {
  if (scenario.workspace?.type !== 'tempProject') return { root: process.cwd() }
  const prefix = scenario.workspace.prefix ?? `${scenario.id}-`
  const root = mkdtempSync(join(tmpdir(), prefix))
  return {
    root,
    cleanup: () => {
      if (process.env.COPSE_EVAL_KEEP_WORKSPACE === '1') return
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function resolveAttachment(attachment: PromptAttachment): { path: string; content: string } {
  if (attachment.content !== undefined)
    return { path: attachment.path, content: attachment.content }
  if (!attachment.fixture) {
    throw new Error(`Attachment ${attachment.path} must define either content or fixture`)
  }
  const fixturePath = resolve(process.cwd(), attachment.fixture)
  return { path: attachment.path, content: readFileSync(fixturePath, 'utf8') }
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

async function approvePendingDiffs(): Promise<void> {
  const approved = await browser.execute(async () => {
    const queuedCount = document.querySelectorAll('.diff-file-btn').length
    if (queuedCount === 0) return 0
    const api = (
      window as unknown as {
        api?: { diff?: { approveAll?: () => Promise<void> } }
      }
    ).api
    if (!api?.diff?.approveAll) throw new Error('window.api.diff.approveAll unavailable')
    await api.diff.approveAll()
    return queuedCount
  })
  if (approved > 0) await browser.pause(200)
}

async function waitForEvalAgentIdle(timeoutMs: number): Promise<void> {
  await browser.waitUntil(
    async () => {
      await approvePendingApprovalDialogs()
      await approvePendingDiffs()
      const stopBtn = await $('.stop-btn')
      return (await stopBtn.isExisting()) && (await stopBtn.getProperty('hidden')) !== true
    },
    {
      timeout: 60_000,
      interval: 100,
      timeoutMsg: 'Agent did not start (Stop button visible)',
    },
  )
  await waitForAgentIdle(timeoutMs)
  await approvePendingDiffs()
  await $('.msg-assistant').waitForExist({ timeout: 30_000 })
  // Autosave debounces thread writes (~250ms); give persistence a beat before export.
  await browser.pause(500)
  await assertNoErrorToasts('agent eval idle')
}

async function attachPromptFiles(attachments: PromptAttachment[]): Promise<void> {
  const files = attachments.map(resolveAttachment)
  if (files.length === 0) return
  await browser.execute(async (dropFiles) => {
    const inputBar = document.getElementById('input-bar')
    if (!inputBar) throw new Error('#input-bar not found')
    const dataTransfer = new DataTransfer()
    for (const file of dropFiles) {
      dataTransfer.items.add(new File([file.content], file.path, { type: 'text/plain' }))
    }
    inputBar.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }),
    )
  }, files)
  await browser.waitUntil(async () => (await $$('.attachment-chip')).length >= files.length, {
    timeout: 5_000,
    interval: 100,
    timeoutMsg: `Expected ${files.length} prompt attachment chip(s)`,
  })
}

async function typePrompt(prompt: EvalPrompt): Promise<void> {
  const text = typeof prompt === 'string' ? prompt : prompt.text
  const attachments = typeof prompt === 'string' ? [] : (prompt.attachments ?? [])
  await waitForPromptReady()
  await attachPromptFiles(attachments)
  await browser.execute((value) => {
    const el = document.querySelector('.prompt-input') as HTMLElement | null
    if (!el) throw new Error('.prompt-input not found')
    el.focus()
    el.textContent = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, text)
}

function walkFiles(root: string): string[] {
  const files: string[] = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === '.git') continue
      const abs = join(dir, entry)
      const stat = statSync(abs)
      if (stat.isDirectory()) {
        visit(abs)
      } else {
        files.push(abs)
      }
    }
  }
  visit(root)
  return files
}

function readWorkspaceFile(root: string, relPath: string): string {
  return readFileSync(join(root, relPath), 'utf8')
}

function assertContainsAll(label: string, content: string, expected: string[]): void {
  for (const value of expected) {
    assert.ok(
      content.toLowerCase().includes(value.toLowerCase()),
      `${label} should contain ${value}`,
    )
  }
}

function htmlFiles(root: string): string[] {
  return walkFiles(root).filter((file) => file.toLowerCase().endsWith('.html'))
}

function findHtmlByName(root: string, name: string): string {
  const match = htmlFiles(root).find((file) => basename(file).toLowerCase() === name.toLowerCase())
  assert.ok(match, `Expected HTML file named ${name}`)
  return match
}

function assertWorkspaceExpectations(root: string, scenario: EvalScenario): void {
  const exp = scenario.assertWorkspace
  if (!exp) return

  if (exp.git) {
    assert.ok(existsSync(join(root, '.git')), 'Expected project to be initialized as a git repo')
    const isRepo = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    assert.equal(isRepo, 'true')
    if (exp.git.minCommits !== undefined) {
      const count = Number(
        execFileSync('git', ['rev-list', '--count', 'HEAD'], {
          cwd: root,
          encoding: 'utf8',
        }).trim(),
      )
      assert.ok(count >= exp.git.minCommits, `Expected at least ${exp.git.minCommits} commits`)
    }
  }

  if (exp.homePage) {
    const relPath = exp.homePage.path ?? 'index.html'
    const content = readWorkspaceFile(root, relPath)
    assertContainsAll(relPath, content, exp.homePage.contains ?? [])
    if (exp.homePage.linksTo) {
      assert.match(
        content,
        new RegExp(`href=["'][^"']*${exp.homePage.linksTo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        `${relPath} should link to ${exp.homePage.linksTo}`,
      )
    }
  }

  if (exp.menuPage) {
    const file = exp.menuPage.path
      ? join(root, exp.menuPage.path)
      : findHtmlByName(root, 'menu.html')
    const content = readFileSync(file, 'utf8')
    assertContainsAll(exp.menuPage.path ?? basename(file), content, exp.menuPage.contains ?? [])
  }

  for (const fileExpectation of exp.filesContain ?? []) {
    const candidates = walkFiles(root).filter((file) => {
      if (!fileExpectation.glob) return true
      if (fileExpectation.glob === '*.html') return file.toLowerCase().endsWith('.html')
      return basename(file) === fileExpectation.glob
    })
    const match = candidates.find((file) => {
      const content = readFileSync(file, 'utf8')
      return fileExpectation.contains.every((value) =>
        content.toLowerCase().includes(value.toLowerCase()),
      )
    })
    assert.ok(
      match,
      `Expected a file matching ${fileExpectation.glob ?? '*'} to contain ${fileExpectation.contains.join(', ')}`,
    )
  }
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

function assertExploreSubagentCompleted(thread: Thread): void {
  const exploreCalls = thread.messages
    .flatMap((m) => m.toolCalls)
    .filter((tc) => tc.name === 'explore')
  assert.ok(exploreCalls.length > 0, 'expected at least one explore tool call')
  const completed = exploreCalls.filter(
    (tc) => tc.status === 'done' && typeof tc.result === 'string' && tc.result.trim().length > 20,
  )
  assert.ok(completed.length > 0, 'expected explore to complete with a non-empty summary result')
}

describe('agent eval drive', () => {
  let scenario: EvalScenario
  let workspaceRoot = process.cwd()
  let cleanupWorkspace: (() => void) | undefined

  before(async () => {
    mkdirSync(ARTIFACTS, { recursive: true })
    resetUserData()
    scenario = loadScenario()
    const project = scenarioProjectRoot(scenario)
    workspaceRoot = project.root
    cleanupWorkspace = project.cleanup
    const useMock = process.env.COPSE_EVAL_USE_MOCK === '1'
    const localServerUrl =
      process.env.COPSE_EVAL_LOCAL_SERVER_URL?.trim() ||
      process.env.COPSE_EVAL_LM_STUDIO_URL?.trim() ||
      'http://localhost:1234/v1'
    const subagentsEnabled =
      process.env.COPSE_EVAL_SUBAGENTS === '0'
        ? false
        : process.env.COPSE_EVAL_SUBAGENTS === '1'
          ? true
          : !useMock
    seedEmptyProject(workspaceRoot, `${scenario.id}-project`, {
      subagentsEnabled,
      ...(useMock
        ? { model: 'claude-sonnet-4-6' }
        : {
            model: DEFAULT_APP_CHAT_MODEL,
            localServerUrl,
            localDefaultModel: LM_STUDIO_MODEL_IDS.chat,
            subagentModel: LM_STUDIO_MODEL_IDS.smallTasks,
            localSubagentsEnabled: true,
          }),
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    cleanupWorkspace?.()
  })

  it('runs scenario prompts against the real agent and writes JSONL artifact', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const idleTimeout = Number(process.env.COPSE_EVAL_IDLE_MS ?? 15 * 60_000)

    for (const prompt of scenario.prompts) {
      await typePrompt(prompt)
      await $('.submit-btn').click()
      await waitForEvalAgentIdle(idleTimeout)
    }

    assertWorkspaceExpectations(workspaceRoot, scenario)

    const thread = readActiveThread()
    if (
      scenario.id === 'working-brief-eval' ||
      scenario.id === 'working-brief-eval-lmstudio' ||
      scenario.id === 'working-brief-subagent-eval'
    ) {
      const firstPrompt = scenario.prompts[0]
      assert.equal(
        thread.workingBrief,
        typeof firstPrompt === 'string' ? firstPrompt : firstPrompt.text,
      )
    }
    if (scenario.id === 'working-brief-subagent-eval' || scenario.id === 'todo-steer-deep-dive') {
      assertExploreSubagentCompleted(thread)
    }
    const body = threadToJsonl(thread)
    const outPath = join(ARTIFACTS, `${scenario.id}-${Date.now()}.jsonl`)
    writeFileSync(outPath, body, 'utf8')
    process.stdout.write(`\nCOPSE_EVAL_ARTIFACT=${outPath}\n`)
  })
})
