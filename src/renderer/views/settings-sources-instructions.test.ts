// Sources → Instructions: reading an instruction file before trusting it, and
// trusting the workspace from the badge that says the file is inert.
import '../../../tests/setup-dom.ts'
import { describe, it, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ProjectInstructionSummary } from '@shared/types/instructions.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { patchPreviewDialog } from '../attachments/preview-dialog.test-support.ts'
import {
  clickActiveConfirmDialogCancel,
  clickActiveConfirmDialogConfirm,
  mountConfirmDialog,
} from './confirm-dialog.ts'
import { mountSettingsDialog } from './settings-dialog.ts'

const AGENTS_MD = '# AGENTS.md\n\nRun `pnpm check` before committing.\n'

function untrusted(): ProjectInstructionSummary {
  return {
    path: '/workspace/AGENTS.md',
    name: 'AGENTS.md',
    scope: 'project',
    bytes: 7129,
    active: false,
  }
}

interface Harness {
  api: ApiClient
  trustCalls: boolean[]
  readPaths: string[]
}

/**
 * `instructions.list` answers from mutable state so a test can assert the list
 * re-rendered after trusting, rather than that the IPC was merely called.
 */
function stubApi(initial: ProjectInstructionSummary[]): Harness {
  const base = createFakeApi()
  let files = initial
  const trustCalls: boolean[] = []
  const readPaths: string[] = []
  const api: ApiClient = {
    ...base,
    instructions: {
      list: () => Promise.resolve(files),
      read: (path: string) => {
        readPaths.push(path)
        return Promise.resolve(AGENTS_MD)
      },
    },
    cursorRules: { ...base.cursorRules, list: () => Promise.resolve([]) },
    skills: { ...base.skills, list: () => Promise.resolve([]) },
    cursorPlugins: { ...base.cursorPlugins, list: () => Promise.resolve([]) },
    hooks: { ...base.hooks, list: () => Promise.resolve({ hooks: [], warnings: [] }) },
    workspace: {
      ...base.workspace,
      unsandboxedProjectHooks: () => Promise.resolve([]),
      setTrusted: (trusted: boolean) => {
        trustCalls.push(trusted)
        files = files.map((file) => ({ ...file, active: trusted }))
        return Promise.resolve([])
      },
    },
  }
  return { api, trustCalls, readPaths }
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 6; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function openInstructions(api: ApiClient): Promise<HTMLElement> {
  document.body.innerHTML = ''
  mountConfirmDialog()
  mountSettingsDialog(createStore(), api)
  const sourcesBtn = document.querySelector<HTMLButtonElement>(
    '.settings-nav-btn[data-section="customise"]',
  )
  assert.ok(sourcesBtn)
  sourcesBtn.click()
  await flush()
  const list = document.getElementById('sources-instructions-list')
  assert.ok(list)
  return list
}

function trustBadge(list: HTMLElement): HTMLButtonElement {
  const button = list.querySelector<HTMLButtonElement>('button.sources-badge-untrusted')
  assert.ok(button, 'the "not loaded" badge should be a button')
  return button
}

describe('settings sources → instructions', () => {
  before(() => {
    patchPreviewDialog()
  })

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('reports file size in KB rather than a raw byte count', async () => {
    const list = await openInstructions(stubApi([untrusted()]).api)
    const detail = list.querySelector('.sources-row-detail')?.textContent ?? ''
    assert.match(detail, /7\.0 KB/)
    assert.doesNotMatch(detail, /7129 B/)
  })

  it('points at the badge as the way to trust an inert file', async () => {
    const list = await openInstructions(stubApi([untrusted()]).api)
    const badge = trustBadge(list)
    assert.equal(badge.textContent, 'not loaded')
    assert.equal(badge.getAttribute('aria-label'), 'Trust this workspace to load AGENTS.md')
    assert.match(
      list.querySelector('.sources-row-detail')?.textContent ?? '',
      /inert until you trust this workspace/,
    )
  })

  it('trusts the workspace from the badge and re-renders the row as loaded', async () => {
    const { api, trustCalls } = stubApi([untrusted()])
    const list = await openInstructions(api)

    trustBadge(list).click()
    await flush()
    assert.match(
      document.querySelector('#confirm-dialog .confirm-dialog-message')?.textContent ?? '',
      /Trust this workspace\?/,
    )
    clickActiveConfirmDialogConfirm()
    await flush()

    assert.deepEqual(trustCalls, [true])
    assert.equal(list.querySelector('button.sources-badge-untrusted'), null)
    assert.equal(list.querySelector('.sources-badge')?.textContent, 'project')
    assert.doesNotMatch(
      list.querySelector('.sources-row-detail')?.textContent ?? '',
      /inert until you trust/,
    )
  })

  it('names unsandboxed project hooks in the confirmation', async () => {
    const { api } = stubApi([untrusted()])
    const withHooks: ApiClient = {
      ...api,
      workspace: {
        ...api.workspace,
        unsandboxedProjectHooks: () =>
          Promise.resolve([{ event: 'afterFileEdit', command: 'scripts/format.sh' }]),
      },
    }
    const list = await openInstructions(withHooks)

    trustBadge(list).click()
    await flush()
    const detail = document.querySelector('#confirm-dialog .confirm-dialog-detail')?.textContent
    assert.match(detail ?? '', /OUTSIDE the project sandbox/)
    assert.match(detail ?? '', /scripts\/format\.sh/)
    clickActiveConfirmDialogCancel()
  })

  it('leaves the workspace untrusted when the confirmation is cancelled', async () => {
    const { api, trustCalls } = stubApi([untrusted()])
    const list = await openInstructions(api)

    const badge = trustBadge(list)
    badge.click()
    await flush()
    clickActiveConfirmDialogCancel()
    await flush()

    assert.deepEqual(trustCalls, [])
    assert.equal(badge.disabled, false, 'a cancelled trust leaves the badge clickable')
  })

  it('opens the file in the preview dialog as plain text', async () => {
    const { api, readPaths } = stubApi([untrusted()])
    const list = await openInstructions(api)

    const title = list.querySelector<HTMLButtonElement>('button.sources-row-title-btn')
    assert.ok(title, 'the file name should be a button')
    assert.equal(title.getAttribute('aria-label'), 'Open AGENTS.md')
    title.click()
    await flush()

    assert.deepEqual(readPaths, ['/workspace/AGENTS.md'])
    const dialog = document.querySelector('dialog.attachment-preview-dialog')
    assert.ok(dialog)
    assert.equal(dialog.querySelector('.attachment-preview-title')?.textContent, 'AGENTS.md')
    const text = dialog.querySelector('pre.attachment-preview-text')
    assert.ok(text, 'contents render as plain text, not markdown')
    assert.equal(text.textContent, AGENTS_MD)
  })
})
