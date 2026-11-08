import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { $, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json'
import type { Thread } from '@shared/types'
import {
  e2eWorkspaceDir,
  resetUserData,
  seedStableWorkspace,
  seedE2eViewport,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { parkPointer, saveAppScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

const DRAFT = 'Ask about the next release when I return.'
const NOTES = 'Keep writing the release notes.'
const owners = [
  { project: 'resident-a', thread: 'resident-thread-a' },
  { project: 'resident-b', thread: 'resident-thread-b' },
] as const

function retainState(label: string): { drafts: Array<string | undefined>; spines: Buffer[] } {
  const artifacts = join(process.cwd(), 'tests/e2e/artifacts/project-switch-composer-draft')
  mkdirSync(artifacts, { recursive: true })
  const drafts: Array<string | undefined> = []
  const spines: Buffer[] = []
  for (const owner of owners) {
    const root = join(e2eWorkspaceDir(), owner.project, owner.thread)
    const metadata = readFileSync(join(root, 'meta.json'))
    const spine = readFileSync(join(root, 'events.jsonl'))
    writeFileSync(join(artifacts, `${label}-${owner.project}-meta.json`), metadata)
    writeFileSync(join(artifacts, `${label}-${owner.project}-events.jsonl`), spine)
    const parsed = safeJsonParse(
      metadata.toString('utf8'),
      decodeWithSchema(z.object({ draftPrompt: z.string().optional() })),
    )
    assert.ok(parsed)
    drafts.push(parsed.draftPrompt)
    spines.push(spine)
  }
  return { drafts, spines }
}

function savedThread(id: string, content: string): Thread {
  return {
    id,
    title: content,
    status: 'idle',
    draftPrompt: 'Continue the review when ready',
    createdAt: 1,
    updatedAt: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    messages: [{ id: `${id}-message`, role: 'user', content, toolCalls: [], createdAt: 1 }],
  }
}

describe('resident conversation navigation across projects', () => {
  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    writeE2eEnv({ COPSE_PANEL_MOCK_GH_STATUS: 'ready' })
    resetUserData()
    const root = seedStableWorkspace()
    writeSeedConfig({
      projects: [
        { id: 'resident-a', path: root, name: 'Project A' },
        { id: 'resident-b', path: `${root}/src`, name: 'Project B' },
      ],
      activeProjectId: 'resident-a',
      activeThreadId: 'resident-thread-a',
      'threads:resident-a': [
        {
          ...savedThread('resident-thread-a', 'Review the application navigation'),
          prRefs: [{ owner: 'copse-dev', repo: 'copse-panel', number: 42 }],
        },
      ],
      'threads:resident-b': [
        {
          ...savedThread('resident-thread-b', 'Review the shared packages'),
          draftPrompt: NOTES,
          prRefs: [{ owner: 'copse-dev', repo: 'copse-panel', number: 99 }],
        },
      ],
    })
    seedE2eViewport({ width: 1280, height: 800 }, { theme: 'dark' })
    await browser.reloadSession()
    await expect($('.msg-user .message-text')).toHaveText('Review the application navigation')
    await expect($('.chat-row.selected .chat-pr-status')).toHaveElementClass('is-open')
    await expect($('.chat-row.selected .chat-running-status')).not.toExist()
  })

  after(() => {
    resetUserData()
  })

  it('renders cached conversations within the click, before IPC can return', async () => {
    await $('[data-project-id="resident-b"] .project-row').click()
    await expect($('.msg-user .message-text')).toHaveText('Review the shared packages')
    await expect($('.chat-row.selected .chat-pr-status')).toHaveElementClass('is-merged')
    await expect($('.chat-row.selected .chat-running-status')).not.toExist()

    // Read the DOM in the very same JS task as the click. An implementation
    // awaiting even one IPC round trip cannot satisfy this assertion.
    const visits: Array<[string, string, string]> = [
      ['resident-a', 'Review the application navigation', 'is-open'],
      ['resident-b', 'Review the shared packages', 'is-merged'],
      ['resident-a', 'Review the application navigation', 'is-open'],
    ]
    for (const [id, content, lifecycle] of visits) {
      const rendered = await browser.execute((projectId) => {
        const row = document.querySelector<HTMLElement>(
          `[data-project-id="${projectId}"] .project-row`,
        )
        if (!row) throw new Error(`Missing project ${projectId}`)
        row.click()
        const icon = document.querySelector('.chat-row.selected .chat-pr-status')
        return {
          content: document.querySelector('.msg-user .message-text')?.textContent,
          lifecycle: icon?.classList.contains('is-merged')
            ? 'is-merged'
            : icon?.classList.contains('is-open')
              ? 'is-open'
              : null,
          working: document.querySelector('.chat-row.selected .chat-running-status') !== null,
        }
      }, id)
      assert.deepEqual(rendered, { content, lifecycle, working: false })
    }
    await saveAppScreenshot('project-switch-resident-thread.png')
  })

  it('keeps the outgoing unsent draft after reloading in another project', async () => {
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', 'resident-thread-a')
    const before = retainState('before')
    // Input and navigation share one event turn, exercising the real handoff
    // before either normal draft debounce can run. No explicit save is sent.
    await browser.execute((text) => {
      const editor = document.querySelector('.prompt-input')
      const destination = document.querySelector('[data-project-id="resident-b"] .project-row')
      if (!(editor instanceof HTMLElement) || !(destination instanceof HTMLElement)) {
        throw new Error('Composer or destination project missing')
      }
      editor.focus()
      editor.textContent = text
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      destination.click()
    }, DRAFT)
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', 'resident-thread-b')
    await expect($('.prompt-input')).toHaveText(NOTES)
    const switched = retainState('switched')
    await browser.reloadSession()
    const reloaded = retainState('reloaded-before-revisit')
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', 'resident-thread-b')
    await expect($('.prompt-input')).toHaveText(NOTES)
    await $('[data-project-id="resident-a"] .project-row').click()
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', 'resident-thread-a')
    await expect($('.msg-user .message-text')).toHaveText('Review the application navigation')
    await expect($('.prompt-input')).toHaveText(DRAFT)
    await expect($('.submit-btn')).toHaveText('Send')
    await expect($('.stop-btn')).not.toBeDisplayed()
    await expect($('.chat-row.selected')).not.toHaveElementClass('is-running')
    await expect($('.chat-row.selected .chat-running-status')).not.toExist()
    const final = retainState('final')
    const threads = await browser.execute(async () => ({
      a: await window.api.threads.loadProject('resident-a'),
      b: await window.api.threads.loadProject('resident-b'),
    }))
    const artifacts = join(process.cwd(), 'tests/e2e/artifacts/project-switch-composer-draft')
    writeFileSync(
      join(artifacts, 'receipt.json'),
      JSON.stringify(
        {
          beforeDrafts: before.drafts,
          switchedDrafts: switched.drafts,
          reloadedDrafts: reloaded.drafts,
          finalDrafts: final.drafts,
          spineHashes: before.spines.map((spine) =>
            createHash('sha256').update(spine).digest('hex'),
          ),
          finalThreads: threads,
        },
        null,
        2,
      ),
    )
    assert.deepEqual(reloaded.drafts, [DRAFT, NOTES])
    assert.deepEqual(final.drafts, [DRAFT, NOTES])
    assert.deepEqual(switched.spines, before.spines)
    assert.deepEqual(reloaded.spines, before.spines)
    assert.deepEqual(final.spines, before.spines)
    for (const project of [threads.a, threads.b]) {
      assert.equal(project.length, 1)
      assert.equal(project[0]?.status, 'idle')
      assert.equal(project[0].currentEpoch, undefined)
      assert.equal(project[0].worktree, undefined)
    }
    await parkPointer()
    await saveAppScreenshot('project-switch-unsent-draft-restored.png')
  })
})
