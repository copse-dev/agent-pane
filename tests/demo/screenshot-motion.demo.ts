import assert from 'node:assert/strict'
import { join } from 'node:path'
import { $, browser } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, withCaptureFrame } from '../e2e/helpers/screenshot.ts'

describe('reference screenshot motion', () => {
  it('pins a visible reasoning frame and resumes motion after success or failure', async () => {
    await browser.url('/?scenario=footer-compact')
    await $('.input-footer').waitForExist()
    await browser.execute(() => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.id = 'capture-motion-fixture'
      svg.setAttribute('viewBox', '0 0 1000 1000')
      svg.style.cssText = 'position:fixed;top:100px;left:400px;width:80px;height:80px'
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('class', 'reasoning-activity-path')
      path.setAttribute('d', 'M200 500 A300 300 0 1 1 500 800')
      path.setAttribute('pathLength', '1')
      svg.append(path)
      document.body.append(svg)
    })
    const motion = () =>
      browser.execute(() => {
        const path = document.querySelector('#capture-motion-fixture path')
        const animation = path?.getAnimations()[0]
        return {
          state: animation?.playState,
          time: animation?.currentTime,
          opacity: path ? getComputedStyle(path).opacity : null,
        }
      })
    await browser.waitUntil(async () => (await motion()).state === 'running')
    await withCaptureFrame(async () => {
      assert.deepEqual(await motion(), { state: 'paused', time: 1250, opacity: '1' })
      await $('#capture-motion-fixture').saveScreenshot(
        join(E2E_SCREENSHOT_DIR, 'screenshot-motion-frame.png'),
      )
      assert.deepEqual(await motion(), { state: 'paused', time: 1250, opacity: '1' })
    })
    assert.equal((await motion()).state, 'running')
    await assert.rejects(
      withCaptureFrame(async () => {
        assert.equal((await motion()).state, 'paused')
        throw new Error('capture failed')
      }),
      /capture failed/,
    )
    assert.equal((await motion()).state, 'running')
  })
})
