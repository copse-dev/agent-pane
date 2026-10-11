import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

describe('Coding agents list in Settings', () => {
  const originalPath = process.env['PATH']
  const originalPreservePath = process.env['COPSE_PRESERVE_PATH']
  let fixtureBin = ''

  before(async function () {
    this.timeout(90_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    // Only Codex is "installed"; Claude, Gemini and Cursor must land in the Add menu.
    fixtureBin = mkdtempSync(join(tmpdir(), 'copse-acp-list-bin-'))
    const agentModule = pathToFileURL(join(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs'))
    const windows = process.platform === 'win32'
    const executable = join(fixtureBin, windows ? 'codex-acp.cmd' : 'codex-acp')
    writeFileSync(
      executable,
      windows
        ? `@echo off\r\n"${process.execPath}" "${join(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs')}" %*\r\n`
        : `#!${process.execPath}\nimport(${JSON.stringify(agentModule.href)})\n`,
    )
    if (!windows) chmodSync(executable, 0o755)
    writeE2eEnv({
      COPSE_PRESERVE_PATH: '1',
      PATH: [
        fixtureBin,
        ...(windows
          ? [join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')]
          : ['/usr/bin', '/bin']),
      ].join(delimiter),
    })
    seedEmptyProject(process.cwd(), 'e2e-acp-agents-list', {
      windowBounds: { width: 1280, height: 800 },
      registeredAcpAgents: [
        { id: 'codex-acp', title: 'Codex', command: 'codex-acp', enabled: true },
      ],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    writeE2eEnv({ COPSE_PRESERVE_PATH: originalPreservePath, PATH: originalPath })
    resetUserData()
    if (fixtureBin) rmSync(fixtureBin, { recursive: true, force: true })
  })

  it('lists installed agents with the chip on the name row and buries the rest under Add', async function () {
    this.timeout(60_000)
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').waitForDisplayed({ timeout: 10_000 })
    await $('.settings-nav-btn[data-section="general"]').click()

    const list = $('[data-testid="acp-agents-list"]')
    await list.waitForExist({ timeout: 15_000 })
    const codex = list.$('.acp-row[data-agent="codex-acp"]')
    await codex.waitForExist({ timeout: 15_000 })
    await expect(codex.$('.acp-logo svg')).toExist()
    // Agents that are not installed are not listed until the user goes looking.
    await expect(list.$('.acp-row[data-agent="cursor"]')).not.toExist()

    // The status chip shares the row with the agent name, whatever its width.
    const chip = codex.$('.acp-row-chip')
    await chip.waitForExist({ timeout: 15_000 })
    const geometry = await browser.execute(() => {
      const name = document.querySelector('.acp-row[data-agent="codex-acp"] .acp-row-name strong')
      const chipEl = document.querySelector('.acp-row[data-agent="codex-acp"] .acp-row-chip')
      const a = name?.getBoundingClientRect()
      const b = chipEl?.getBoundingClientRect()
      if (!a || !b) return null
      return { nameMid: a.top + a.height / 2, chipMid: b.top + b.height / 2 }
    })
    assert.ok(geometry, 'name and chip must both render')
    assert.ok(Math.abs(geometry.nameMid - geometry.chipMid) <= 4, 'chip is on the name row')

    // Nothing in a row overlaps the next thing, and no row scrolls sideways.
    const collisions = await browser.execute(() => {
      const out: string[] = []
      for (const row of document.querySelectorAll('.acp-row')) {
        if (row.scrollWidth > row.clientWidth)
          out.push(`${row.getAttribute('data-agent')}: overflow`)
        const parts = [
          '.acp-logo',
          '.acp-row-name strong',
          '.acp-row-chip',
          '.acp-row-head > button',
        ].flatMap((sel) => {
          const el = row.querySelector(sel)
          return el ? [{ sel, r: el.getBoundingClientRect() }] : []
        })
        for (const [i, a] of parts.entries()) {
          for (const b of parts.slice(i + 1)) {
            const apart =
              a.r.right <= b.r.left + 0.5 ||
              b.r.right <= a.r.left + 0.5 ||
              a.r.bottom <= b.r.top + 0.5 ||
              b.r.bottom <= a.r.top + 0.5
            if (!apart) out.push(`${row.getAttribute('data-agent')}: ${a.sel} overlaps ${b.sel}`)
          }
        }
      }
      return out
    })
    assert.deepEqual(collisions, [], 'row parts must not overlap or overflow')

    await $('[data-testid="acp-add-toggle"]').click()
    for (const id of ['claude-acp', 'gemini', 'cursor']) {
      await expect($(`.acp-add-row[data-agent="${id}"]`)).toBeDisplayed()
    }
    await $('[data-testid="acp-agents-fieldset"]').scrollIntoView({ block: 'center' })
    await browser.pause(200)
    await saveElementScreenshot(
      '[data-testid="acp-agents-fieldset"]',
      'settings-acp-agents-list.png',
    )
  })
})
