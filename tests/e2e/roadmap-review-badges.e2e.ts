import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

function knowledgeNamespace(workspaceRoot: string): string {
  const name =
    basename(workspaceRoot)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'workspace'
  const hash = createHash('sha1').update(workspaceRoot).digest('hex').slice(0, 8)
  return `${name}-${hash}`
}

function seedRoadmapNote(
  workspaceRoot: string,
  input: {
    title: string
    body: string
    status?: string
    issue?: string
    reviewVerdict?: string
    reviewDetail?: string
    createdAt?: string
  },
): void {
  const id = randomUUID()
  // Orphan notes (seeded as bare files with no index entry) are healed in
  // (createdAt, id) order, so distinct createdAt values keep the row order
  // deterministic regardless of readdir order. Callers pass ordered timestamps.
  const createdAt = input.createdAt ?? new Date().toISOString()
  const now = new Date().toISOString()
  const dir = join(homedir(), '.copse', 'knowledge', knowledgeNamespace(workspaceRoot), 'roadmap')
  mkdirSync(dir, { recursive: true })
  const lines = [
    '---',
    'type: Roadmap',
    `id: ${id}`,
    `title: ${input.title}`,
    `status: ${input.status ?? 'ready'}`,
    `createdAt: ${createdAt}`,
    `updatedAt: ${now}`,
  ]
  if (input.issue) lines.push(`issue: ${input.issue}`)
  if (input.reviewVerdict) lines.push(`reviewVerdict: ${input.reviewVerdict}`)
  if (input.reviewDetail) lines.push(`reviewDetail: ${input.reviewDetail}`)
  lines.push('---', '', input.body)
  writeFileSync(join(dir, `${id}.md`), `${lines.join('\n')}\n`, 'utf8')
}

describe('roadmap review badges', () => {
  let workspaceRoot: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-roadmap-review-'))
    seedEmptyProject(workspaceRoot, 'e2e-roadmap-review', {
      model: 'claude-sonnet-4-6',
      roadmapPlansEnabled: true,
    })
    seedRoadmapNote(workspaceRoot, {
      title: 'Fix startup flash',
      body: 'Ensure dark theme applies before first paint.',
      issue: '#41',
      reviewVerdict: 'likely',
      reviewDetail: 'Recent commit mentions theme initialization.',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    seedRoadmapNote(workspaceRoot, {
      title: 'Terminal shortcut',
      body: 'Add a keyboard shortcut to toggle the terminal pane.',
      status: 'ready',
      reviewVerdict: 'open',
      reviewDetail: 'No matching commits since last review.',
      createdAt: '2026-01-02T00:00:00.000Z',
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('shows the review button and persisted review verdict badges', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const roadmapButton = $('.titlebar-text-btn[aria-label="Open roadmap"]')
    await roadmapButton.waitForDisplayed({ timeout: 10_000 })
    await roadmapButton.click()
    await $('.roadmap-review-btn').waitForDisplayed({ timeout: 10_000 })
    await $('.roadmap-row').waitForDisplayed({ timeout: 10_000 })

    const badges = await $$('.roadmap-review-badge')
    assert.equal(badges.length, 2)
    await expect(badges[0]).toHaveText(expect.stringContaining('review: likely'))
    await expect(badges[1]).toHaveText(expect.stringContaining('review: open'))

    await $('.roadmap-row').click()
    await $('.roadmap-row.is-selected').waitForDisplayed({ timeout: 5_000 })
    const reviewBox = $('.roadmap-review-result')
    await expect(reviewBox).toBeDisplayed()
    await expect(reviewBox).toHaveText(expect.stringContaining('review: likely'))
    await expect(reviewBox).toHaveText(expect.stringContaining('theme initialization'))

    await saveAppScreenshot('roadmap-review-badges.png')
  })
})
