import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  chromiumLicensePath,
  licenseFilePath,
  licensesDir,
  openableLicenseFile,
  readThirdPartyLicenseReport,
} from './third-party-licenses.ts'

describe('shipped licence files', () => {
  it('points a packaged app at the unpacked copy, which other apps can open', () => {
    assert.equal(
      licensesDir('/Applications/Copse.app/Contents/Resources/app.asar/dist/main'),
      '/Applications/Copse.app/Contents/Resources/app.asar.unpacked/dist/resources/licenses',
    )
    assert.equal(licensesDir('/repo/dist/main'), '/repo/dist/resources/licenses')
  })

  it('names each file by what it covers', () => {
    assert.equal(licenseFilePath('third-party', '/l'), '/l/THIRD_PARTY_LICENSES.txt')
    assert.equal(
      licenseFilePath('chromium', '/l', '/runtime/LICENSES.chromium.html'),
      '/runtime/LICENSES.chromium.html',
    )
    assert.equal(licenseFilePath('copse', '/l'), '/l/LICENSE.txt')
  })

  it('finds electron-builder notices on macOS, Windows and Linux', () => {
    assert.equal(
      chromiumLicensePath({
        platform: 'darwin',
        resourcesPath: '/Applications/Copse.app/Contents/Resources',
        execPath: '/Applications/Copse.app/Contents/MacOS/Copse',
        isPackaged: true,
      }),
      '/Applications/Copse.app/Contents/Resources/LICENSES.chromium.html',
    )
    assert.equal(
      chromiumLicensePath({
        platform: 'darwin',
        resourcesPath: '/repo/node_modules/electron/dist/Copse.app/Contents/Resources',
        execPath: '/repo/node_modules/electron/dist/Copse.app/Contents/MacOS/Electron',
        isPackaged: false,
      }),
      '/repo/node_modules/electron/dist/LICENSES.chromium.html',
    )
    for (const platform of ['linux', 'win32'] as const) {
      assert.equal(
        chromiumLicensePath({
          platform,
          resourcesPath: '/opt/Copse/resources',
          execPath: '/opt/Copse/copse',
          isPackaged: true,
        }),
        '/opt/Copse/LICENSES.chromium.html',
      )
    }
  })

  it('returns plain files that another application can open', () => {
    assert.equal(
      openableLicenseFile('chromium', '/licenses', '/runtime/LICENSES.chromium.html'),
      '/runtime/LICENSES.chromium.html',
    )
    assert.equal(
      openableLicenseFile('third-party', '/licenses', '/runtime/LICENSES.chromium.html'),
      '/licenses/THIRD_PARTY_LICENSES.txt',
    )
  })

  describe('report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copse-about-'))
    after(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('reads a report the build wrote', async () => {
      const valid = join(dir, 'valid')
      const report = {
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
        ],
        texts: ['Mozilla Public License Version 2.0'],
      }
      mkdirSync(valid)
      writeFileSync(join(valid, 'third-party-licenses.json'), JSON.stringify(report))
      assert.deepEqual(await readThirdPartyLicenseReport(valid), report)
    })

    it('is null when the build wrote none, or wrote something else', async () => {
      assert.equal(await readThirdPartyLicenseReport(join(dir, 'absent')), null)
      const wrong = join(dir, 'wrong')
      mkdirSync(wrong)
      writeFileSync(join(wrong, 'third-party-licenses.json'), '{"version":2,"components":[]}')
      assert.equal(await readThirdPartyLicenseReport(wrong), null)
    })
  })
})
