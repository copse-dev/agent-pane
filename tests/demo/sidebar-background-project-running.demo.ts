import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

describe('running agent in another project', () => {
  it('sweeps color across the collapsed project name without moving it after switching projects', async () => {
    await browser.url('/?scenario=sidebar-background-project-running')
    await $(
      '.project-entry[data-project-id="demo-running-project"] .chat-row.is-running',
    ).waitForExist()
    const nameBeforeSwitch = await browser.execute(
      () =>
        document
          .querySelector('.project-entry[data-project-id="demo-running-project"] .project-name')
          ?.getBoundingClientRect().left,
    )

    await $('.project-entry[data-project-id="demo-running-other"] .project-row').click()
    await browser.waitUntil(async () => {
      const row = $('.project-entry[data-project-id="demo-running-project"] .project-row')
      return (await row.getAttribute('class'))?.includes('active') === false
    })

    const projectRow = $('.project-entry[data-project-id="demo-running-project"] .project-row')
    await expect(projectRow).toHaveElementClass('is-running')
    await expect(projectRow).toHaveAttribute('aria-label', 'workbench — agent is working')
    await expect(projectRow.$('.project-name')).toHaveText('workbench')
    await expect(projectRow.$('.chat-running-status')).not.toExist()
    await expect(
      $('.project-entry[data-project-id="demo-running-other"] .project-row'),
    ).not.toHaveElementClass('is-running')

    const layout = await browser.execute(() => {
      const row = document.querySelector(
        '.project-entry[data-project-id="demo-running-project"] .project-row',
      )
      const name = row?.querySelector('.project-name')
      const chevron = row?.querySelector('.project-twisty')
      if (!row || !name || !chevron) return null
      const rowRect = row.getBoundingClientRect()
      const chevronRect = chevron.getBoundingClientRect()
      const menuRect = row.parentElement
        ?.querySelector('.project-menu-btn')
        ?.getBoundingClientRect()
      const idleNameRect = document
        .querySelector('.project-entry[data-project-id="demo-running-other"] .project-name')
        ?.getBoundingClientRect()
      const nameRect = name.getBoundingClientRect()
      return {
        nameFits: name.scrollWidth <= name.clientWidth,
        nameLeft: nameRect.left,
        namesAligned: idleNameRect ? Math.abs(nameRect.left - idleNameRect.left) < 1 : false,
        chevronBeforeName: chevronRect.right <= nameRect.left,
        chevronInsideRow: chevronRect.left >= rowRect.left,
        chevronClearMenu: menuRect ? chevronRect.right < menuRect.left : false,
        chevronAnimation: getComputedStyle(chevron).animationName,
        nameAnimation: getComputedStyle(name).animationName,
        chevronDuration: getComputedStyle(chevron).animationDuration,
        nameDuration: getComputedStyle(name).animationDuration,
      }
    })
    expect(layout).not.toBeNull()
    expect(layout?.nameFits).toBe(true)
    expect(layout?.nameLeft).toBe(nameBeforeSwitch)
    expect(layout?.namesAligned).toBe(true)
    expect(layout?.chevronBeforeName).toBe(true)
    expect(layout?.chevronInsideRow).toBe(true)
    expect(layout?.chevronClearMenu).toBe(true)
    expect(layout?.chevronAnimation).toBe('project-chevron-color-sweep')
    expect(layout?.nameAnimation).toBe('project-name-color-sweep')
    expect(layout?.chevronDuration).toBe(layout?.nameDuration)

    const captureSweepFrame = async (filename: string, time: number): Promise<void> => {
      await saveAppScreenshot(filename, undefined, async () => {
        await browser.execute((frameTime) => {
          const row = document.querySelector(
            '.project-entry[data-project-id="demo-running-project"] .project-row',
          )
          for (const animation of row?.getAnimations({ subtree: true }) ?? []) {
            if (animation.effect?.getTiming().iterations === Infinity)
              animation.currentTime = frameTime
          }
        }, time)
      })
    }
    await captureSweepFrame('sidebar-background-project-chevron.png', 650)
    await captureSweepFrame('sidebar-background-project-name.png', 1200)
  })
})
