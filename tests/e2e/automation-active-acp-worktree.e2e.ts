import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '../../src/shared/safe-json.ts'
import { waitForAgentIdle } from './helpers.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  seedE2eViewport,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { parkPointer, pinTextForCapture, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT = 'e2e-active-acp-automation'
const OTHER = 'e2e-active-acp-notes'
const SCHEDULE = 'background-verification'
const ROUTE = 'acp:background-fixture#fixture-model'
const SEEDED_AT = Date.parse('2026-11-06T12:00:00Z')
const savedMeta = z.object({
  id: z.string(),
  status: z.enum(['idle', 'running', 'error']),
  currentEpoch: z.string().optional(),
  continuationUsed: z.number().optional(),
  worktree: z
    .looseObject({ path: z.string(), branch: z.string(), retiredAt: z.number().optional() })
    .optional(),
})
const machineLine = z.looseObject({
  type: z.literal('machine_continuation'),
  phase: z.enum(['started', 'finished']),
  budgetUsed: z.number(),
  result: z.string().optional(),
})

function meta(id: string): z.infer<typeof savedMeta> {
  const parsed = safeJsonParse(
    readFileSync(join(e2eWorkspaceDir(), PROJECT, id, 'meta.json'), 'utf8'),
    decodeWithSchema(savedMeta),
  )
  assert.ok(parsed)
  return parsed
}
function runs(): string[] {
  const project = join(e2eWorkspaceDir(), PROJECT)
  return existsSync(project)
    ? readdirSync(project).filter((id) => existsSync(join(project, id, 'meta.json')))
    : []
}
function machineAudit(id: string, phase: 'started' | 'finished'): boolean {
  const spine = join(e2eWorkspaceDir(), PROJECT, id, 'events.jsonl')
  if (!existsSync(spine)) return false
  return readFileSync(spine, 'utf8')
    .split('\n')
    .some((line) => {
      const parsed = safeJsonParse(line, decodeWithSchema(machineLine))
      return parsed?.phase === phase && (phase === 'started' || parsed.result === 'completed')
    })
}
function live(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
async function cleanUp(): Promise<void> {
  const schedule = $(
    `.automation-schedule-group[data-schedule-id="${SCHEDULE}"] .automation-schedule-toggle`,
  )
  const target = (await schedule.isExisting())
    ? schedule
    : $('.automation-thread-rows .chat-row.is-automation.selected')
  await target.click({ button: 'right' })
  await $('.context-menu-item=Clean up finished runs…').click()
}
async function expandRuns(): Promise<void> {
  const section = $('.automation-threads-toggle')
  await section.waitForExist({ timeout: 10_000 })
  if ((await section.getAttribute('aria-expanded')) === 'false') await section.click()
  const schedule = $(
    `.automation-schedule-group[data-schedule-id="${SCHEDULE}"] .automation-schedule-toggle`,
  )
  if ((await schedule.isExisting()) && (await schedule.getAttribute('aria-expanded')) === 'false')
    await schedule.click()
}
async function selectRun(id: string, title: string | RegExp): Promise<void> {
  await expandRuns()
  const selector = `.automation-thread-rows .chat-row[data-thread-id="${id}"]`
  await $(selector).waitForDisplayed({ timeout: 10_000 })
  const alreadySelected = await browser.execute(
    (threadId: string) =>
      document
        .querySelector(
          `.automation-thread-rows .chat-row[data-thread-id="${CSS.escape(threadId)}"]`,
        )
        ?.classList.contains('selected') ?? false,
    id,
  )
  if (!alreadySelected) await $(selector).click()
  await expect($(selector)).toHaveAttribute('class', expect.stringContaining('selected'))
  await expect($(selector).$('.chat-title')).toHaveText(title)
}

async function waitForFirstPrompt(id: string): Promise<void> {
  await waitForAgentIdle()
  await expect($('.messages-list')).toHaveText(
    expect.stringContaining(
      'The first check is complete. Background verification will report back shortly.',
    ),
  )
  await browser.waitUntil(
    () => /^copse\/background-verification-[a-f0-9]+$/.test(meta(id).worktree?.branch ?? ''),
    { timeout: 15_000, timeoutMsg: 'the completed run never received its friendly branch' },
  )
  const branch = meta(id).worktree?.branch
  assert.ok(branch)
  await expect($('.footer-branch-label')).toHaveText(branch)
}

async function runNowFromProject(): Promise<void> {
  await $(`.project-entry[data-project-id="${PROJECT}"] .project-menu-btn`).click()
  await $('.context-menu-item=Automations').click()
  const dialog = $('#automation-dialog')
  await dialog.$('.automation-run-btn').click()
  await expect(dialog.$('.automation-status')).toHaveText('Started “Background verification”.')
  await dialog.$('[aria-label="Close automations"]').click()
}

async function pinRunTimes(): Promise<() => Promise<void>> {
  const restores: Array<() => Promise<void>> = []
  for (const id of runs()) {
    const selector = `.automation-schedule-runs .chat-row[data-thread-id="${id}"] .chat-title`
    if (!(await $(selector).isExisting())) continue
    const text = await $(selector).getText()
    const prefix = text.startsWith('Latest · ') ? 'Latest · ' : ''
    restores.push(await pinTextForCapture(selector, /^.+$/, `${prefix}Jan 1, 2026, 12:00 AM`))
  }
  return async (): Promise<void> => {
    for (const restore of restores) await restore()
  }
}

async function pinRunBranch(): Promise<() => Promise<void>> {
  const pattern = /^copse\/background-verification-[a-f0-9]+$/
  await expect($('.footer-branch-label')).toHaveText(pattern)
  return pinTextForCapture('.footer-branch-label', pattern, 'copse/background-verification-000001')
}

describe('automation checkout while an ACP background tool owns it', function () {
  this.timeout(120_000)
  const originalMock = process.env['COPSE_PANEL_MOCK_LLM']
  let projectRoot = ''
  before(async () => {
    resetUserData()
    writeE2eEnv({ COPSE_PANEL_MOCK_LLM: '0' })
    const worktrees = process.env['COPSE_WORKTREES_DIR']
    assert.ok(worktrees)
    projectRoot = join(dirname(worktrees), 'active-acp-project')
    const notes = join(dirname(worktrees), 'active-acp-notes')
    mkdirSync(projectRoot, { recursive: true })
    mkdirSync(notes, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectRoot })
    writeFileSync(
      join(projectRoot, 'README.md'),
      'Verify this project without losing background work.\n',
    )
    writeFileSync(join(projectRoot, '.gitignore'), '.copse-fixture/\n')
    execFileSync('git', ['add', '.'], { cwd: projectRoot })
    execFileSync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Copse E2E',
        '-c',
        'user.email=e2e@example.invalid',
        'commit',
        '-qm',
        'seed',
      ],
      { cwd: projectRoot },
    )
    writeSeedConfig({
      projects: [
        { id: PROJECT, path: projectRoot, name: 'verification project' },
        { id: OTHER, path: notes, name: 'notes' },
      ],
      activeProjectId: OTHER,
      activeThreadId: 'notes',
      [`threads:${OTHER}`]: [
        {
          id: 'notes',
          title: 'Notes',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: SEEDED_AT,
          updatedAt: SEEDED_AT,
        },
      ],
      [`threads:${PROJECT}`]: [],
      // Every other plugin on, but not PII redaction: its contextual classifier
      // downloads an ONNX model from huggingface.co (the e2e network guard refuses it).
      pluginDisabled: ['copse.pii-redaction'],
      pluginMigration: { automationsEnablement: true },
      plugin: {
        copse: {
          automations: {
            storage: [
              {
                id: SCHEDULE,
                projectId: PROJECT,
                name: 'Background verification',
                cron: '* * * * *',
                prompt: 'Verify the project and preserve unfinished background work.',
                model: ROUTE,
                enabled: false,
                maxLiveWorktrees: 1,
                createdAt: SEEDED_AT,
                updatedAt: SEEDED_AT,
              },
            ],
          },
        },
      },
    })
    seedE2eViewport(
      { width: 1280, height: 800 },
      {
        model: ROUTE,
        registeredAcpAgents: [
          { id: 'codex-acp', title: 'Codex', command: 'codex-acp', enabled: false },
          {
            id: 'background-fixture',
            title: 'Background fixture',
            command: process.execPath,
            args: [join(process.cwd(), 'tests/fixtures/automation-background-acp.mjs')],
            enabled: true,
            model: 'fixture-model',
            availableModels: [{ value: 'fixture-model', label: 'Fixture model' }],
            modelsProbedAt: Date.now(),
          },
        ],
      },
    )
    await browser.reloadSession()
  })
  after(() => {
    writeE2eEnv({ COPSE_PANEL_MOCK_LLM: originalMock })
    resetUserData()
  })

  it('keeps the child and checkpoint while pending, then releases a settled checkout and starts a fresh run', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.project-row*=verification project').click()
    await runNowFromProject()
    await browser.waitUntil(
      () =>
        runs().length === 1 &&
        runs().every(
          (id) =>
            meta(id).status === 'idle' &&
            existsSync(join(meta(id).worktree?.path ?? '', '.copse-fixture/pid')),
        ),
      { timeout: 30_000 },
    )
    const [oldId] = runs()
    assert.ok(oldId)
    const oldCheckout = meta(oldId).worktree?.path
    assert.ok(oldCheckout)
    const pid = Number(readFileSync(join(oldCheckout, '.copse-fixture/pid'), 'utf8'))
    assert.ok(Number.isInteger(pid) && pid > 0 && live(pid))
    await selectRun(oldId, 'Background verification')
    await waitForFirstPrompt(oldId)
    writeFileSync(join(oldCheckout, '.copse-fixture/begin-background'), 'report background work\n')
    await browser.waitUntil(
      () =>
        existsSync(join(oldCheckout, '.copse-fixture/started')) && machineAudit(oldId, 'started'),
      { timeout: 15_000, timeoutMsg: 'the ACP child never began its post-prompt background work' },
    )
    await expect($('.messages-list [data-tool-id="background-verification"]')).toHaveAttribute(
      'data-status',
      'running',
    )
    await expect($('.messages-list')).toHaveText(
      expect.stringContaining('Background verification is running.'),
    )
    const before = meta(oldId)
    assert.equal(
      before.status,
      'idle',
      'the durable prompt has ended while ACP owns background work',
    )
    const paths = [
      join(e2eWorkspaceDir(), PROJECT, oldId, 'events.jsonl'),
      join(oldCheckout, '.copse-fixture/checkpoint.txt'),
    ]
    const raw = paths.map((path) => readFileSync(path))
    const epoch = join(e2eWorkspaceDir(), PROJECT, oldId, 'agent-epoch.json')
    assert.ok(existsSync(epoch), 'the admitted ACP turn must have its authoritative epoch')
    const epochBefore = readFileSync(epoch)
    await cleanUp()
    const held = $('#confirm-dialog')
    await held.waitForDisplayed({ timeout: 10_000 })
    await expect(held.$('.confirm-dialog-message')).toHaveText(
      '1 run of “Background verification” still holds a worktree',
    )
    await expect(held.$('.confirm-dialog-detail')).toHaveText(
      expect.stringContaining(
        'still has an agent, terminal or background process using the checkout',
      ),
    )
    assert.equal(runs().length, 1)
    assert.equal(live(pid), true)
    assert.equal(meta(oldId).worktree?.path, oldCheckout)
    assert.equal(meta(oldId).worktree?.retiredAt, undefined)
    const heldState = meta(oldId)
    const heldBytes = paths.map((path) => readFileSync(path))
    for (let index = 0; index < raw.length; index++) assert.deepEqual(heldBytes[index], raw[index])
    const epochHeld = readFileSync(epoch)
    assert.deepEqual(epochHeld, epochBefore)
    const artifacts = join(process.cwd(), 'tests/e2e/artifacts/automation-active-acp')
    mkdirSync(artifacts, { recursive: true })
    for (let index = 0; index < raw.length; index++) {
      const beforeBytes = raw[index]
      const afterBytes = heldBytes[index]
      assert.ok(beforeBytes)
      assert.ok(afterBytes)
      writeFileSync(join(artifacts, `before-${String(index)}.bin`), beforeBytes)
      writeFileSync(join(artifacts, `held-${String(index)}.bin`), afterBytes)
    }
    const heldHashes = raw.map((beforeBytes, index) => {
      const afterBytes = heldBytes[index]
      const path = paths[index]
      assert.ok(afterBytes)
      assert.ok(path)
      return { path, before: sha256(beforeBytes), after: sha256(afterBytes) }
    })
    const heldProof = {
      oldThreadId: oldId,
      oldCheckout,
      oldPid: pid,
      heldHashes,
      epochBefore: epochBefore.toString(),
      epochHeld: epochHeld.toString(),
      epochHashes: {
        before: sha256(epochBefore),
        held: sha256(epochHeld),
      },
      before,
      held: heldState,
    }
    writeFileSync(join(artifacts, 'held-receipt.json'), JSON.stringify(heldProof, null, 2) + '\n')
    const restoreHeldTime = await pinTextForCapture(
      '#confirm-dialog .confirm-dialog-detail',
      / · [^”]+(?=”)/g,
      ' · Jan 1, 2026, 12:00 AM',
    )
    const restoreHeldRows = await pinRunTimes()
    const restoreHeldBranch = await pinRunBranch()
    await parkPointer()
    await saveAppScreenshot('automation-active-acp-held.png')
    await restoreHeldBranch()
    await restoreHeldRows()
    await restoreHeldTime()
    await held.$('.confirm-dialog-cancel').click()
    writeFileSync(join(oldCheckout, '.copse-fixture/release'), 'finish\n')
    await browser.waitUntil(() => machineAudit(oldId, 'finished'), {
      timeout: 15_000,
      timeoutMsg: 'the reported ACP tool/lease never became terminal',
    })
    await cleanUp()
    await expect($('.toast')).toHaveText(expect.stringContaining('Freed 1 worktree'))
    await browser.waitUntil(() => !existsSync(oldCheckout) && !live(pid), { timeout: 15_000 })
    const retiredAt = meta(oldId).worktree?.retiredAt
    assert.ok(retiredAt)
    await runNowFromProject()
    await browser.waitUntil(
      () =>
        runs().length === 2 &&
        runs()
          .filter((id) => id !== oldId)
          .every(
            (id) =>
              meta(id).status === 'idle' &&
              existsSync(join(meta(id).worktree?.path ?? '', '.copse-fixture/pid')),
          ),
      { timeout: 30_000 },
    )
    const newId = runs().find((id) => id !== oldId)
    assert.ok(newId)
    const fresh = meta(newId)
    const newCheckout = fresh.worktree?.path
    assert.ok(newCheckout)
    assert.notEqual(newCheckout, oldCheckout)
    await selectRun(newId, /^Latest · .+$/)
    await waitForFirstPrompt(newId)
    writeFileSync(join(newCheckout, '.copse-fixture/begin-background'), 'report background work\n')
    await browser.waitUntil(
      () =>
        existsSync(join(newCheckout, '.copse-fixture/started')) && machineAudit(newId, 'started'),
      { timeout: 15_000 },
    )
    writeFileSync(join(newCheckout, '.copse-fixture/release'), 'finish\n')
    await browser.waitUntil(() => machineAudit(newId, 'finished'), { timeout: 15_000 })
    assert.equal(meta(oldId).worktree?.retiredAt, retiredAt)
    assert.equal(existsSync(oldCheckout), false)
    const epochAfterFresh = readFileSync(epoch)
    assert.deepEqual(epochAfterFresh, epochBefore)
    for (const [label, id] of [
      ['old', oldId],
      ['new', newId],
    ]) {
      assert.ok(label && id)
      const events = readFileSync(join(e2eWorkspaceDir(), PROJECT, id, 'events.jsonl'), 'utf8')
      const continuations = events.split('\n').flatMap((line) => {
        const parsed = safeJsonParse(line, decodeWithSchema(machineLine))
        return parsed ? [{ phase: parsed.phase, used: parsed.budgetUsed }] : []
      })
      assert.deepEqual(continuations, [
        { phase: 'started', used: 1 },
        { phase: 'finished', used: 1 },
      ])
      writeFileSync(join(artifacts, `settled-${label}-events.jsonl`), events)
      writeFileSync(
        join(artifacts, `settled-${label}-meta.json`),
        readFileSync(join(e2eWorkspaceDir(), PROJECT, id, 'meta.json')),
      )
    }
    writeFileSync(
      join(artifacts, 'receipt.json'),
      JSON.stringify(
        {
          ...heldProof,
          newThreadId: newId,
          newCheckout,
          epochAfterFresh: epochAfterFresh.toString(),
          epochAfterFreshSha256: sha256(epochAfterFresh),
          oldPidExitedAfterSettlement: !live(pid),
          retired: meta(oldId),
          freshInitial: fresh,
          fresh: meta(newId),
        },
        null,
        2,
      ) + '\n',
    )
    // Exercise real navigation back to the requested run as well as the
    // already-selected path used immediately after Run now.
    await $('.project-row*=notes').click()
    await expect(
      $(`.automation-thread-rows .chat-row.selected[data-thread-id="${newId}"]`),
    ).not.toBeExisting()
    await selectRun(newId, /^Latest · .+$/)
    await waitForFirstPrompt(newId)
    await expect($('.messages-list')).toHaveText(expect.stringContaining('Background verification'))
    await expect($('.messages-list [data-tool-id="background-verification"]')).toHaveAttribute(
      'data-status',
      'done',
    )
    await expect(
      $(`.automation-schedule-group[data-schedule-id="${SCHEDULE}"] .automation-schedule-held`),
    ).toHaveText('1 held')
    // The earlier cleanup result is temporary feedback. Let it expire through
    // the real toast lifetime before capturing the fresh run's settled state.
    await $('.toast').waitForExist({ reverse: true, timeout: 10_000 })
    const restoreTime = await pinRunTimes()
    const restoreBranch = await pinRunBranch()
    await parkPointer()
    await saveAppScreenshot('automation-active-acp-settled.png')
    await restoreBranch()
    await restoreTime()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await expandRuns()
    assert.equal(meta(oldId).worktree?.retiredAt, retiredAt)
    assert.equal(existsSync(oldCheckout), false)
    assert.deepEqual(readFileSync(epoch), epochBefore)
    writeFileSync(
      join(artifacts, 'reloaded-old-meta.json'),
      readFileSync(join(e2eWorkspaceDir(), PROJECT, oldId, 'meta.json')),
    )
    await expect(
      $(`.automation-schedule-group[data-schedule-id="${SCHEDULE}"] .automation-schedule-held`),
    ).toHaveText('1 held')
    await cleanUp()
    await browser.waitUntil(() => !existsSync(newCheckout), { timeout: 15_000 })
  })
})
