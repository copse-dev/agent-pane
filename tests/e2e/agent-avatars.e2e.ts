import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setComposerValue } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'

// Real Electron eval: the generated SVG must decode under the app's CSP, retain
// its identity after the filesystem thread store reloads, and fit chat chrome.
const projectId = 'e2e-riso-project'
const threadId = 'e2e-riso-thread'
const timestamp = 1_700_000_000_000
const framesDir = mkdtempSync(join(tmpdir(), 'copse-avatar-frames-'))

function seedAgentAvatars(live = false): void {
  const tasks = [
    {
      id: 'explore-layout',
      query: 'Find the chat layout',
      summary: 'The conversation view owns the transcript and delegated-agent cards.',
    },
    {
      id: 'explore-tests',
      query: 'Find the visual tests',
      summary: 'Focused Electron specs seed a conversation and capture the rendered UI.',
    },
  ]
  seedEmptyProject(process.cwd(), projectId, {
    model: live ? 'acp:maple' : 'claude-sonnet-4-6',
    subagentsEnabled: false,
    registeredAcpAgents: [
      {
        id: 'maple',
        title: 'Maple',
        command: process.execPath,
        args: [join(process.cwd(), 'tests/e2e/fixtures/riso-agent.cjs')],
        enabled: live,
      },
    ],
  })
  writeSeedConfig({
    projects: [{ id: projectId, path: process.cwd(), name: 'Copse' }],
    activeProjectId: projectId,
    activeThreadId: threadId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'A little character, where it matters',
        status: 'idle',
        messages: [
          {
            id: 'riso-user',
            role: 'user',
            content: 'Ask the remote agent to check the build, then have Maple review the copy.',
            toolCalls: [],
            createdAt: timestamp,
          },
          {
            id: 'riso-assistant-plan',
            role: 'assistant',
            content: 'I’ve checked the workspace. I’ll hand off the build and copy reviews.',
            model: 'claude-sonnet-4-6',
            createdAt: timestamp + 1,
            toolCalls: tasks.map((task) => ({
              id: task.id,
              name: 'explore',
              args: { query: task.query },
              status: 'done',
              result: task.summary,
              subagent: {
                id: task.id,
                kind: 'explore',
                status: 'done',
                prompt: task.query,
                summary: task.summary,
                model: 'claude-sonnet-4-6',
                messages: [
                  {
                    id: `${task.id}-message`,
                    role: 'assistant',
                    content: task.summary,
                    toolCalls: [],
                  },
                ],
              },
            })),
          },
          {
            id: 'remote-first',
            role: 'assistant',
            model: 'remote-agent:cursor',
            content: 'The build passed. I’m checking the packaged app next.',
            toolCalls: [],
            createdAt: timestamp + 2,
          },
          {
            id: 'remote-followup',
            role: 'assistant',
            model: 'remote-agent:cursor',
            content: 'The packaged app opens correctly too.',
            toolCalls: [],
            createdAt: timestamp + 3,
          },
          {
            id: 'named-first',
            role: 'assistant',
            model: 'acp:maple',
            content:
              'The copy is clear. I’d shorten the opening sentence and keep the action labels.',
            toolCalls: [],
            createdAt: timestamp + 4,
          },
          {
            id: 'named-followup',
            role: 'assistant',
            model: 'acp:maple',
            content: 'I’ve added those suggestions to the review.',
            toolCalls: [],
            createdAt: timestamp + 5,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: timestamp,
        updatedAt: timestamp + 5,
      },
    ],
  })
}

async function loadedAvatarSources(count = 2): Promise<string[]> {
  await $('.message-agent .agent-avatar').waitForExist()
  await browser.waitUntil(
    () =>
      browser.execute((expected) => {
        const images = [...document.querySelectorAll<HTMLImageElement>('.agent-avatar')]
        return (
          images.length === expected && images.every((img) => img.complete && img.naturalWidth > 0)
        )
      }, count),
    { timeout: 15_000, timeoutMsg: 'Riso SVG images did not decode' },
  )
  return browser.execute(() =>
    [...document.querySelectorAll<HTMLImageElement>('.agent-avatar')].map((img) => img.src),
  )
}

/** The id of the latest assistant reply that carries an agent marker. */
async function latestMarkedReplyId(): Promise<string> {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const replies = [...document.querySelectorAll<HTMLElement>('.msg-assistant')]
        return replies.at(-1)?.querySelector('.message-agent .agent-avatar') != null
      }),
    { timeout: 15_000, timeoutMsg: 'Expected the latest reply to carry an agent marker' },
  )
  return browser.execute(
    () =>
      [...document.querySelectorAll<HTMLElement>('.msg-assistant')]
        .at(-1)
        ?.getAttribute('data-message-id') ?? '',
  )
}

async function openMotionSettings(): Promise<void> {
  await $('[aria-label="Settings"]').click()
  await $('.settings-nav-btn[data-section="appearance"]').click()
  await $('[data-testid="settings-agent-motion"]').scrollIntoView({ block: 'center' })
  await $('input[name="animateAgentAvatars"]').waitForDisplayed()
}

async function saveMotionSettings(): Promise<void> {
  await $('.settings-buttons button[type="submit"]').click()
  await $('#settings-dialog').waitForDisplayed({ reverse: true })
}

describe('riso avatars in agent chat', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedAgentAvatars()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(framesDir, { recursive: true, force: true })
  })

  it('uses distinct styles only at remote and named-agent boundaries', async () => {
    const sources = await loadedAvatarSources()
    expect(new Set(sources).size).toBe(2)
    const styles = await browser.execute(() =>
      [...document.querySelectorAll('.agent-avatar')].map((img) =>
        img.getAttribute('data-avatar-style'),
      ),
    )
    expect(styles).toEqual(['duotone', 'riso'])
    expect(await $('[data-message-id="riso-assistant-plan"] .agent-avatar').isExisting()).toBe(
      false,
    )
    expect(await $('[data-message-id="remote-followup"] .agent-avatar').isExisting()).toBe(false)
    expect(await $('[data-message-id="named-followup"] .agent-avatar').isExisting()).toBe(false)
    expect(await $('.tool-card-subagent .agent-avatar').isExisting()).toBe(false)
    expect(await $('.msg-user .agent-avatar').isExisting()).toBe(false)
    const sizes = await browser.execute(() =>
      [...document.querySelectorAll('.agent-avatar')].map((img) => {
        const rect = img.getBoundingClientRect()
        return [rect.width, rect.height]
      }),
    )
    expect(sizes).toEqual([
      [28, 28],
      [28, 28],
    ])
    await saveAppScreenshot('agent-avatars-dark.png')

    const card = await $('.tool-card-subagent')
    await card.$('summary').click()
    await expect(card).toHaveAttribute('open')
    await expect(card.$('.subagent-timeline')).toBeDisplayed()
    await expect(card.$('.tool-status-icon')).toExist()
    await saveAppScreenshot('agent-avatars-expanded.png')

    await browser.reloadSession()
    expect(await loadedAvatarSources()).toEqual(sources)
    await browser.execute(() => {
      document.documentElement.dataset['theme'] = 'light'
    })
    await saveAppScreenshot('agent-avatars-light.png')
  })

  it('moves only the active ink and honors visibility and reduced motion', async function () {
    this.timeout(60_000)
    seedAgentAvatars(true)
    await browser.reloadSession()
    await browser.sendCommandAndGetResult('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    })
    await loadedAvatarSources()
    await setComposerValue('Review the next section.')
    await $('.submit-btn').click()
    await expect($('.messages-list')).toHaveText(
      expect.stringContaining('I’m reviewing the next section.'),
    )
    // A user turn ends Maple's stretch, so the new reply carries its own
    // marker and that one — not named-first, far above — is the one that moves.
    const activeId = await latestMarkedReplyId()
    expect(activeId).not.toBe('named-first')
    const active = await $(`[data-message-id="${activeId}"] .agent-avatar`)
    await expect($('[data-message-id="named-first"] .agent-avatar')).not.toHaveAttribute(
      'data-avatar-active',
    )
    const remote = await $('[data-message-id="remote-first"] .agent-avatar')
    await expect(active).toHaveAttribute('data-avatar-animating')
    await expect(remote).not.toHaveAttribute('data-avatar-active')
    const stationary = await remote.saveScreenshot(join(framesDir, 'idle.png'))
    const firstFrame = await active.saveScreenshot(join(framesDir, 'working-start.png'))
    await browser.pause(4_000)
    const nextFrame = await active.saveScreenshot(join(framesDir, 'working-next.png'))
    expect(nextFrame.equals(firstFrame)).toBe(false)
    expect((await remote.saveScreenshot(join(framesDir, 'idle-next.png'))).equals(stationary)).toBe(
      true,
    )
    expect(await active.getSize()).toEqual({ width: 28, height: 28 })
    await saveAppScreenshot('agent-avatars-active.png')

    await browser.execute(() => {
      const img = document.querySelector<HTMLElement>('[data-avatar-active]')
      if (img) img.style.transform = 'translateY(-2000px)'
    })
    await expect(active).not.toHaveAttribute('data-avatar-animating')
    await browser.execute(() => {
      const img = document.querySelector<HTMLElement>('[data-avatar-active]')
      if (img) img.style.removeProperty('transform')
    })
    await expect(active).toHaveAttribute('data-avatar-animating')
    await browser.sendCommandAndGetResult('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })
    await expect(active).not.toHaveAttribute('data-avatar-animating')
    const reduced = await active.saveScreenshot(join(framesDir, 'reduced.png'))
    await browser.pause(500)
    expect((await active.saveScreenshot(join(framesDir, 'reduced-next.png'))).equals(reduced)).toBe(
      true,
    )
    await saveAppScreenshot('agent-avatars-reduced-motion.png')
    await browser.sendCommandAndGetResult('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    })
    await expect(active).toHaveAttribute('data-avatar-animating')
    await openMotionSettings()
    const toggle = await $('input[name="animateAgentAvatars"]')
    await expect(toggle).toBeChecked()
    await toggle.click()
    await saveElementScreenshot('#settings-dialog', 'agent-avatars-appearance.png')
    await saveMotionSettings()
    await expect(active).not.toHaveAttribute('data-avatar-animating')
    expect((await loadedAvatarSources(3)).length).toBe(3)
    await openMotionSettings()
    await expect($('input[name="animateAgentAvatars"]')).not.toBeChecked()
    await $('input[name="animateAgentAvatars"]').click()
    await saveMotionSettings()
    await expect(active).toHaveAttribute('data-avatar-animating')
    await $('.stop-btn').click()
    await waitForAgentIdle(15_000)
    await expect(active).not.toHaveAttribute('data-avatar-active')
    await expect(active).not.toHaveAttribute('data-avatar-animating')
  })

  it('restores the disabled preference after relaunch and keeps a working agent static', async function () {
    this.timeout(60_000)
    await openMotionSettings()
    await $('input[name="animateAgentAvatars"]').click()
    await saveMotionSettings()
    const avatarsBefore = await browser.execute(
      () => document.querySelectorAll('.agent-avatar').length,
    )
    await browser.reloadSession()
    await loadedAvatarSources(avatarsBefore)
    await openMotionSettings()
    await expect($('input[name="animateAgentAvatars"]')).not.toBeChecked()
    await $('#settings-close').click()
    await $('#settings-dialog').waitForDisplayed({ reverse: true })
    const previousReplies = await browser.execute(
      () => document.querySelectorAll('.msg-assistant').length,
    )
    await setComposerValue('Review one final section.')
    await $('.submit-btn').click()
    await $('.stop-btn').waitForDisplayed()
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelectorAll('.msg-assistant').length)) >
        previousReplies,
      { timeout: 15_000, timeoutMsg: 'Expected the named agent to start a second reply' },
    )
    const avatar = await $(`[data-message-id="${await latestMarkedReplyId()}"] .agent-avatar`)
    await expect(avatar).not.toHaveAttribute('data-avatar-animating')
    expect(
      await browser.execute(() => document.querySelectorAll('[data-avatar-animating]').length),
    ).toBe(0)
    await saveAppScreenshot('agent-avatars-motion-disabled.png')
    await $('.stop-btn').click()
    await waitForAgentIdle(15_000)
  })
})
