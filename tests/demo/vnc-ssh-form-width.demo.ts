import assert from 'node:assert/strict'
import { $, browser } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

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
      await browser.execute((px) => {
        document.getElementById('body')?.style.setProperty('--tree-width', `${String(px)}px`)
      }, width)
      const measured = await browser.execute(() => {
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
      assert.ok(measured)
      assert.ok(measured.scroll <= measured.client + 1, JSON.stringify(measured))
      assert.deepEqual(measured.overflow, [])
      await $('.vnc-ssh-host-actions').scrollIntoView()
      await saveElementScreenshot('.vnc-ssh-host-actions', `vnc-ssh-actions-${String(width)}.png`)
    })
  }

  it('explains the disabled SSH prerequisite before saving a machine', async () => {
    await browser.execute(async () => window.api.settings.set('sshWorkspaceEnabled', false))
    await $('[aria-label="SSH host label"]').setValue('Build Mac')
    await $('[aria-label="SSH hostname"]').setValue('build.local')
    await $('.vnc-ssh-host-form button[type="submit"]').click()
    await browser.waitUntil(async () =>
      (await $('.vnc-ssh-host-status').getText()).includes('Enable SSH workspaces in Settings'),
    )
    assert.equal(await $('.vnc-ssh-host-form').isDisplayed(), true)
    await $('.vnc-ssh-host-status').scrollIntoView()
    await saveElementScreenshot('.vnc-ssh-host-status', 'vnc-ssh-disabled-workspaces.png')
  })
})
