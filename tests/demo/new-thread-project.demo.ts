import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'
import { pinDemoClock } from './helpers/fixed-clock.ts'

async function choose(label: string): Promise<void> {
  for (const item of await $$('.context-menu-item')) {
    if ((await item.$('.context-menu-item-label').getText()) === label) {
      await item.click()
      return
    }
  }
  throw new Error('Missing project/menu choice: ' + label)
}

async function expectProject(name: string, id: string): Promise<void> {
  await expect($('.workspace-name')).toHaveText(name)
  await expect($('.workspace-name')).toBeEnabled()
  await expect($('.pane-chat.is-activity-home')).toExist()
  await browser.waitUntil(async () => {
    const navigation = await browser.execute(() => window.api.windowState.getNavigation())
    return navigation.activeProjectId === id && navigation.activeThreadId !== null
  })
}

describe('new-thread project selection', () => {
  before(async () => {
    await pinDemoClock()
    await browser.url('about:blank')
    await browser.url('/?scenario=activity-home')
    await $('.pane-chat.is-activity-home').waitForExist({ timeout: 30_000 })
    // Observe the real submission at the API boundary; navigation and typing still
    // go through the product UI. The browser demo supplies the model response.
    await browser.execute(() => {
      const run = window.api.agent.run
      window.api.agent.run = (projectId, threadId, payload): ReturnType<typeof run> => {
        document.documentElement.dataset['submittedProject'] = projectId
        document.documentElement.dataset['submittedThread'] = threadId
        return run(projectId, threadId, payload)
      }
    })
    await $('.projects-sort-btn').click()
    await choose('Status')
  })

  it('uses the sidebar project for the open composer and retains it for All projects', async () => {
    await $('.projects-filter-btn').click()
    await choose('docs-site')
    await expectProject('docs-site', 'demo-activity-other-docs')
    await expect($('.projects-filter-label')).toHaveText('docs-site')
    await expect($('.workspace-name-chevron')).toBeDisplayed()
    const alignment = await browser.execute(() => {
      const label = document.querySelector('.workspace-name-label')
      const chevron = document.querySelector('.workspace-name-chevron')
      if (!label || !chevron) throw new Error('Missing picker label or chevron')
      const text = label.getBoundingClientRect()
      const icon = chevron.getBoundingClientRect()
      return {
        centreOffset: icon.y + icon.height / 2 - (text.y + text.height / 2),
        followsLabel: icon.x >= text.right,
        pickers: [
          '.workspace-name-chevron',
          '.projects-filter-btn svg',
          '.projects-sort-btn svg',
          '.model-picker-chevron svg',
          '.branch-picker-chevron svg',
          '.open-in-editor-caret svg',
        ].map((selector) => {
          const element = document.querySelector(selector)
          if (!element) throw new Error(`Missing picker chevron: ${selector}`)
          const style = getComputedStyle(element)
          // Include wrapper opacity: the model and branch pickers used to dim
          // their wrappers, unlike the project and editor pickers.
          let opacity = Number(style.opacity)
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            opacity *= Number(getComputedStyle(parent).opacity)
          }
          return {
            appearance: {
              width: style.width,
              height: style.height,
              shape: element.querySelector('path')?.getAttribute('d'),
              strokeWidth: style.strokeWidth,
              linecap: style.strokeLinecap,
              linejoin: style.strokeLinejoin,
              opacity,
            },
            visible: element.getClientRects().length > 0,
            composer: element.closest('.input-footer') !== null,
            transform: style.transform,
          }
        }),
      }
    })
    expect(alignment.centreOffset).toBeCloseTo(1, 1)
    expect(alignment.followsLabel).toBe(true)
    for (const picker of alignment.pickers) {
      expect(picker.appearance).toEqual(alignment.pickers[0]?.appearance)
      expect(picker.appearance.opacity).toBe(0.7)
      // Hidden SVGs have no used transform until they participate in layout.
      if (picker.visible) {
        const expectedTransform = picker.composer ? 'none' : alignment.pickers[0]?.transform
        expect(picker.transform).toBe(expectedTransform)
      }
    }
    await saveAppScreenshot('new-thread-selected-project.png')
    await $('.projects-filter-btn').click()
    await choose('All projects')
    await expectProject('docs-site', 'demo-activity-other-docs')
    await expect($('.projects-filter-label')).toHaveText('All projects')
  })

  it('uses the top-bar picker to open a fresh composer in a project with existing conversations', async () => {
    await $('.workspace-name').click()
    await expect($('.context-menu')).toBeDisplayed()
    await saveAppScreenshot('new-thread-project-picker.png')
    await choose('copse-demo')
    await expectProject('copse-demo', 'demo-activity-home-project')
    await expect($('.projects-filter-label')).toHaveText('copse-demo')
    await expect($('.prompt-input')).toHaveText('')
    const navigation = await browser.execute(() => window.api.windowState.getNavigation())
    expect(navigation.activeThreadId).not.toBe('demo-activity-home-copy')
    expect(navigation.activeThreadId).not.toBe('demo-activity-home-refactor')
  })

  it('submits in the chosen project and keeps the existing conversation when only the filter changes', async () => {
    await $('.workspace-name').click()
    await choose('docs-site')
    await expectProject('docs-site', 'demo-activity-other-docs')
    const navigation = await browser.execute(() => window.api.windowState.getNavigation())
    await $('.prompt-input').setValue('Explain the documentation structure.')
    await $('.submit-btn').click()
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.documentElement.dataset['submittedProject'])) !==
        undefined,
    )
    const submitted = await browser.execute(() => ({
      projectId: document.documentElement.dataset['submittedProject'],
      threadId: document.documentElement.dataset['submittedThread'],
    }))
    expect(submitted).toEqual({
      projectId: 'demo-activity-other-docs',
      threadId: navigation.activeThreadId,
    })
    await expect($('.workspace-name')).toBeDisabled()
    await expect($('.workspace-name-chevron')).not.toBeDisplayed()
    await $('.projects-filter-btn').click()
    await choose('copse-demo')
    await expect($('.workspace-name')).toHaveText('docs-site')
    await $('.projects-add-btn').click()
    await choose('New thread')
    await expectProject('copse-demo', 'demo-activity-home-project')
  })

  it('uses the sidebar project from the keyboard new-thread shortcut', async () => {
    // Filter while viewing a running conversation, then open a fresh thread.
    await $('.chat-row[data-thread-id="demo-activity-home-audit"]').click()
    await expect($('.workspace-name')).toBeDisabled()
    await $('.projects-filter-btn').click()
    await choose('docs-site')
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await browser.keys([modifier, 'n'])
    await expectProject('docs-site', 'demo-activity-other-docs')
  })
})
