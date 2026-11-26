import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

async function setRailWidth(px: number): Promise<void> {
  await browser.execute((width) => {
    document.getElementById('body')?.style.setProperty('--tree-width', `${String(width)}px`)
  }, px)
}

/** Whether the form's controls, and the rail's scroller, stay within the rail. */
async function measureForm(): Promise<{
  client: number
  scroll: number
  overflow: (string | null)[]
} | null> {
  return browser.execute(() => {
    const form = document.querySelector('.vnc-ssh-host-form')
    const scroller = form?.closest('.vnc-controls-body')
    if (!(form instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return null
    const box = form.getBoundingClientRect()
    return {
      client: scroller.clientWidth,
      scroll: scroller.scrollWidth,
      overflow: [...form.querySelectorAll('input, button')]
        .filter((control) => {
          const bounds = control.getBoundingClientRect()
          return bounds.left < box.left || bounds.right > box.right
        })
        .map((control) => control.textContent || control.getAttribute('aria-label')),
    }
  })
}

describe('SSH machine form in a narrow Desktop rail', () => {
  before(async () => {
    await browser.url('/?scenario=vnc-saved-login')
    await $('[data-panel-control="vnc"]').waitForDisplayed()
    await $('[data-panel-control="vnc"]').click()
    await $('.vnc-add-ssh-btn').waitForDisplayed()
    await $('.vnc-add-ssh-btn').click()
  })
  for (const width of [200, 160]) {
    it(`keeps fields and actions within ${String(width)}px`, async () => {
      await setRailWidth(width)
      const measured = await measureForm()
      assert.ok(measured)
      assert.ok(measured.scroll <= measured.client + 1, JSON.stringify(measured))
      assert.deepEqual(measured.overflow, [])
      await $('.vnc-ssh-host-actions').scrollIntoView()
      await saveElementScreenshot('.vnc-ssh-host-actions', `vnc-ssh-actions-${String(width)}.png`)
    })
  }

  it('asks to turn on SSH workspaces in place before saving a machine', async () => {
    await setRailWidth(160)
    await browser.execute(async () => window.api.settings.set('sshWorkspaceEnabled', false))
    await $('[aria-label="SSH host label"]').setValue('Build Mac')
    await $('[aria-label="SSH hostname"]').setValue('build.local')
    await $('.vnc-ssh-host-form button[type="submit"]').click()
    const ask = $('.vnc-ssh-host-form .ssh-consent')
    await ask.waitForDisplayed()
    assert.equal(
      await $('.vnc-ssh-host-form .ssh-consent-title').getText(),
      'Turn on SSH workspaces?',
    )
    // The machine is not saved, and the setting stays off, until the user agrees.
    assert.equal(await $('.vnc-ssh-host-form').isDisplayed(), true)
    assert.equal(
      await browser.execute(async () => window.api.settings.get('sshWorkspaceEnabled')),
      false,
    )
    // The question wraps inside the 160px rail, and turning on is reachable by
    // scrolling the rail. (Here the form's own Cancel declines.)
    const narrow = await measureForm()
    assert.ok(narrow)
    assert.ok(narrow.scroll <= narrow.client + 1, JSON.stringify(narrow))
    assert.deepEqual(narrow.overflow, [])
    const turnOn = $('.vnc-ssh-host-form .ssh-consent-turn-on')
    await turnOn.scrollIntoView({ block: 'end' })
    await expect(turnOn).toBeDisplayedInViewport()

    // At 200px the whole question fits in the rail, so capture it there.
    await setRailWidth(200)
    const wide = await measureForm()
    assert.ok(wide)
    assert.deepEqual(wide.overflow, [])
    const fits = await browser.execute(() => {
      const question = document.querySelector('.vnc-ssh-host-form .ssh-consent')
      const rail = question?.closest('.vnc-controls-body')
      if (!question || !rail) return null
      return question.getBoundingClientRect().height <= rail.clientHeight
    })
    assert.equal(fits, true, 'the question fits the rail at 200px')
    await ask.scrollIntoView({ block: 'end' })
    await saveElementScreenshot(
      '.vnc-ssh-host-form .ssh-consent',
      'vnc-ssh-disabled-workspaces.png',
    )
  })
})
