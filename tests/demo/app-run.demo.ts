import { $, browser, expect } from '@wdio/globals'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('shared Apple and Android Run app picker', () => {
  before(async () => {
    await build({
      entryPoints: ['tests/demo/helpers/app-run-fixture.ts'],
      outfile: 'dist/demo/app-run-fixture.js',
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      tsconfig: 'tsconfig.web.json',
    })
    await writeFile(
      'dist/demo/app-run-fixture.html',
      '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script src="/app-run-fixture.js"></script></body></html>',
    )
  })
  for (const platform of ['apple', 'android'])
    it(`shows ${platform} app and stopped device without enrollment`, async () => {
      await browser.url(`/app-run-fixture.html?mode=${platform}`)
      await $('.app-run-run').waitForEnabled()
      await expect($('.app-run-app')).toHaveValue('sample-app')
      await expect($('.app-run-device')).toHaveValue('phone')
      await expect($('.app-run-device option')).toHaveText(expect.stringContaining('Stopped'))
      await expect($('.app-run-more')).not.toHaveAttribute('open')
      await saveElementScreenshot('#app-run-dialog', `app-run-${platform}-picker.png`)
    })
  it('uses the shared dialog chrome and scales with the interface', async () => {
    await browser.url('/app-run-fixture.html?mode=android')
    await $('.app-run-run').waitForEnabled()
    // Off-token before #3065: a 12px radius on --bg-base with 20px padding and
    // an 8px action gap, next to every other dialog's --radius-lg on
    // --bg-elevated with --spacing-xl and --spacing-md.
    const read = () =>
      browser.execute(() => {
        const dialog = document.querySelector<HTMLElement>('#app-run-dialog')
        const actions = document.querySelector<HTMLElement>('.app-run-panel .app-run-actions')
        const title = document.querySelector<HTMLElement>('#app-run-title')
        if (!dialog || !actions || !title) return null
        const resolve = (property: string, token: string): string => {
          const probe = document.createElement('div')
          probe.style.setProperty(property, `var(${token})`)
          dialog.append(probe)
          const value = getComputedStyle(probe).getPropertyValue(property)
          probe.remove()
          return value
        }
        const style = getComputedStyle(dialog)
        return {
          radius: style.borderTopLeftRadius,
          background: style.backgroundColor,
          padding: style.paddingTop,
          actionGap: getComputedStyle(actions).columnGap,
          titleSize: getComputedStyle(title).fontSize,
          tokens: {
            radius: resolve('border-top-left-radius', '--radius-lg'),
            background: resolve('background-color', '--bg-elevated'),
            padding: resolve('padding-top', '--spacing-xl'),
            actionGap: resolve('column-gap', '--spacing-md'),
            titleSize: resolve('font-size', '--font-size-lg'),
          },
        }
      })
    const base = await read()
    expect(base).not.toBeNull()
    if (!base) return
    expect(base.radius).toBe(base.tokens.radius)
    expect(base.background).toBe(base.tokens.background)
    expect(base.padding).toBe(base.tokens.padding)
    expect(base.actionGap).toBe(base.tokens.actionGap)
    expect(base.titleSize).toBe(base.tokens.titleSize)
    // The dialog focuses its close button on open; drop the ring for the shot.
    await browser.execute(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })
    await saveElementScreenshot('#app-run-dialog', 'app-run-dialog-chrome.png')

    // Tokens are what carry the interface scale; a raw 20px would not move.
    await browser.execute(() => {
      document.documentElement.style.setProperty('--ui-scale', '1.25')
    })
    const scaled = await read()
    await browser.execute(() => {
      document.documentElement.style.removeProperty('--ui-scale')
    })
    expect(scaled?.padding).toBe(`${String(Number.parseFloat(base.padding) * 1.25)}px`)
    expect(scaled?.actionGap).toBe(`${String(Number.parseFloat(base.actionGap) * 1.25)}px`)
  })
  it('shows actual operation stage/logs and cancellation', async () => {
    await browser.url('/app-run-fixture.html?mode=android')
    await $('.app-run-run').waitForEnabled()
    await $('.app-run-run').click()
    await expect($('.app-run-stage')).toHaveText('Building')
    await $('.app-run-logs summary').click()
    await expect($('.app-run-log')).toHaveText(expect.stringContaining('compileDebugKotlin'))
    await expect($('.app-run-run')).toBeDisabled()
    await saveElementScreenshot('#app-run-dialog', 'app-run-progress.png')
    await $('.app-run-cancel').click()
    await expect($('.app-run-stage')).toHaveText('Cancelled')
  })
  it('shows missing setup and separates image download from device creation', async () => {
    await browser.url('/app-run-fixture.html?mode=setup')
    await expect($('.app-run-notice')).toHaveText('Create a device to run this app.')
    await expect($('.app-run-run')).toBeDisabled()
    await $('.app-run-create').click()
    await expect($('.app-run-setup-apply')).toHaveText('Create device')
    await $('[aria-label="Device runtime"]').selectByAttribute('value', 'android-36')
    await expect($('.app-run-setup-apply')).toHaveText('Download selected image')
    const visible = await browser.execute(() => {
      const dialog = document.querySelector('#app-run-dialog')?.getBoundingClientRect()
      const apply = document.querySelector('.app-run-setup-apply')?.getBoundingClientRect()
      return !!dialog && !!apply && apply.bottom <= dialog.bottom && apply.top >= dialog.top
    })
    expect(visible).toBe(true)
    await saveElementScreenshot('#app-run-dialog', 'app-run-setup.png')
  })
})
