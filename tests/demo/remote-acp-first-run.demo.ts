import { $, $$, browser, expect } from '@wdio/globals'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

/**
 * First-run ACP over SSH: one-time host setup is named in the activity row
 * while the agent is reached, and shells Copse opens on its own for an SSH
 * project wait for the user instead of raising "Open remote terminal?".
 */
describe('remote ACP first run', () => {
  before(async () => {
    await build({
      entryPoints: ['tests/demo/helpers/remote-acp-first-run-fixture.ts'],
      outfile: 'dist/demo/remote-acp-first-run-fixture.js',
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      tsconfig: 'tsconfig.web.json',
    })
    await writeFile(
      'dist/demo/remote-acp-first-run-fixture.html',
      '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/remote-acp-first-run-fixture.css"></head><body><main id="fixture" style="width:1100px;height:600px;display:flex"><div style="flex:1;min-width:0;display:flex;flex-direction:column"><div id="conversation" style="flex:1;min-height:0;overflow:auto"></div></div><div style="width:460px;display:flex;flex-direction:column;border-left:1px solid var(--border)"><div id="shells"></div><div id="viewer" style="flex:1;min-height:0;display:flex;flex-direction:column"></div></div></main><script src="/remote-acp-first-run-fixture.js"></script></body></html>',
    )
  })

  const creates = (): Promise<number> =>
    browser.execute(() => window.remoteFirstRun.terminalCreates)

  it('names setup progress and keeps automatic remote shells waiting', async () => {
    await browser.url('/remote-acp-first-run-fixture.html')

    // The Shells pane was left open: its restored tab waits rather than asking.
    await expect($('.terminals-tab-panel[data-awaiting-connect]')).toBeExisting()
    await expect($('.terminals-tab-panel.is-active')).toHaveText(
      expect.stringContaining('Remote shell on Dev.'),
    )
    expect(await creates()).toBe(0)

    await browser.execute(() => {
      window.remoteFirstRun.sendChunk({
        type: 'agent_setup_progress',
        phase: 'setup',
        label: 'Installing @agentclientprotocol/claude-agent-acp@0.31.0 on Dev (one-time setup)…',
      })
    })
    await expect($('.agent-activity-label')).toHaveText(
      'Installing @agentclientprotocol/claude-agent-acp@0.31.0 on Dev (one-time setup)…',
    )
    await expect($('.agent-activity')).toBeDisplayed()
    await browser.execute(async () => {
      await document.fonts.ready
      for (const animation of document.querySelector('.reasoning-activity-path')?.getAnimations() ??
        []) {
        animation.pause()
        animation.currentTime = 1250
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
    await saveElementScreenshot('#fixture', 'remote-acp-first-run-setup.png', {
      frame: 'document',
    })

    // The agent is reached: the row returns to the turn's own activity.
    await browser.execute(() => {
      window.remoteFirstRun.sendChunk({ type: 'agent_setup_progress', phase: 'ready' })
    })
    await expect($('.agent-activity-label')).not.toHaveText(
      expect.stringContaining('one-time setup'),
    )

    // Starting a new thread adds its own shell, which waits too.
    await browser.execute(() => {
      window.remoteFirstRun.startThread('thread-2')
    })
    await expect($$('.terminals-tab-panel[data-awaiting-connect]')).toBeElementsArrayOfSize(2)
    expect(await creates()).toBe(0)

    // Only the user's click opens the remote shell (behind the usual approval).
    await $('.terminals-tab-panel.is-active .terminal-container').click()
    await browser.waitUntil(async () => (await creates()) === 1)
    await expect($('.terminals-tab-panel.is-active')).not.toHaveAttribute('data-awaiting-connect')
  })
})
