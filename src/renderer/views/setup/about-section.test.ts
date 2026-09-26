import '../../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AboutInfo, LicenseFileKind } from '@shared/third-party-licenses.mts'
import type { ApiClient } from '../../../preload/api.d.ts'
import { createFakeApi } from '../../fake-api.test-support.ts'
import { createAboutSection } from './about-section.ts'

const INFO: AboutInfo = {
  version: '0.1.0-beta.9',
  report: {
    version: 1,
    components: [
      {
        name: '@novnc/novnc',
        version: '1.7.0',
        license: 'MPL-2.0',
        source: 'https://github.com/novnc/noVNC',
        shippedAs: ['bundled'],
        partOf: null,
        files: [{ name: 'LICENSE.txt', text: 0 }],
      },
      {
        name: 'github.com/spf13/cobra',
        version: 'v1.10.2',
        license: 'Apache-2.0',
        source: null,
        shippedAs: ['vendored'],
        partOf: 'gortex',
        files: [{ name: 'LICENSE.txt', text: 1 }],
      },
      {
        name: 'lazy-val',
        version: '1.0.5',
        license: 'MIT',
        source: null,
        shippedAs: ['node_modules'],
        partOf: null,
        note: 'The published package omits its licence file.',
        files: [{ name: 'LICENSE', text: 2 }],
      },
    ],
    texts: ['Mozilla Public License Version 2.0', 'Apache License 2.0', 'MIT License'],
  },
}

function apiWith(info: AboutInfo, opened: LicenseFileKind[] = []): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    about: {
      getInfo: async () => info,
      openLicenseFile: async (kind): Promise<void> => {
        opened.push(kind)
      },
    },
  } satisfies ApiClient
}

function rows(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.about-licenses-list > li'))
}

describe('Settings → About', () => {
  it('shows the version and one row per component', async () => {
    const section = createAboutSection(apiWith(INFO))
    await section.refresh()
    assert.match(section.root.textContent, /Version 0\.1\.0-beta\.9\./)
    assert.match(section.root.textContent, /built with the 3 open-source components/)
    assert.deepEqual(
      rows(section.root).map((row) => row.querySelector('.about-license-name')?.textContent),
      ['@novnc/novnc', 'github.com/spf13/cobra', 'lazy-val'],
    )
    assert.equal(rows(section.root)[0]?.querySelector('.about-license-id')?.textContent, 'MPL-2.0')
  })

  it('builds a licence text only when its row opens', async () => {
    const section = createAboutSection(apiWith(INFO))
    await section.refresh()
    const [, cobra, lazyVal] = rows(section.root)
    const details = cobra?.querySelector('details')
    assert.ok(details)
    assert.equal(details.querySelector('.about-license-text'), null)
    details.open = true
    details.dispatchEvent(new Event('toggle'))
    assert.equal(details.querySelector('.about-license-text')?.textContent, 'Apache License 2.0')
    assert.match(details.textContent, /Compiled into gortex/)

    const lazyDetails = lazyVal?.querySelector('details')
    assert.ok(lazyDetails)
    lazyDetails.open = true
    lazyDetails.dispatchEvent(new Event('toggle'))
    assert.equal(
      lazyDetails.querySelector('.about-license-note')?.textContent,
      'The published package omits its licence file.',
    )
  })

  it('filters by name or licence and counts what is shown', async () => {
    const section = createAboutSection(apiWith(INFO))
    await section.refresh()
    const filter = section.root.querySelector<HTMLInputElement>('.about-licenses-filter')
    assert.ok(filter)
    const hidden = (): boolean[] => rows(section.root).map((row) => row.hidden === true)
    const status = (): string | null | undefined =>
      section.root.querySelector('.about-licenses-status')?.textContent
    filter.value = 'MIT'
    filter.dispatchEvent(new Event('input'))
    assert.deepEqual(hidden(), [true, true, false])
    assert.equal(status(), '1 of 3 components')
    filter.value = 'cobra'
    filter.dispatchEvent(new Event('input'))
    assert.deepEqual(hidden(), [true, false, true])
    filter.value = ''
    filter.dispatchEvent(new Event('input'))
    assert.deepEqual(hidden(), [false, false, false])
    assert.equal(status(), '3 components')
  })

  it('keeps the component list out of any fieldset, so Settings search ignores it', async () => {
    const section = createAboutSection(apiWith(INFO))
    await section.refresh()
    assert.equal(section.root.querySelector('.about-licenses-list')?.closest('fieldset'), null)
    assert.equal(section.root.querySelectorAll('fieldset').length, 2)
  })

  it('opens each licence file by kind', async () => {
    const opened: LicenseFileKind[] = []
    const section = createAboutSection(apiWith(INFO, opened))
    for (const button of section.root.querySelectorAll<HTMLButtonElement>(
      'button[data-license-file]',
    )) {
      button.click()
    }
    await Promise.resolve()
    assert.deepEqual(opened, ['copse', 'third-party', 'chromium'])
  })

  it('says so when the build shipped no report', async () => {
    const section = createAboutSection(apiWith({ version: '0.0.0-dev', report: null }))
    await section.refresh()
    assert.match(
      section.root.querySelector('.about-licenses-status')?.textContent ?? '',
      /no licence report/,
    )
    assert.equal(rows(section.root).length, 0)
  })
})
