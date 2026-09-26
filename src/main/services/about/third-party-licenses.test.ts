import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
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
    assert.equal(licenseFilePath('chromium', '/l'), '/l/LICENSES.chromium.html.gz')
    assert.equal(licenseFilePath('copse', '/l'), '/l/LICENSE.txt')
  })

  it('decompresses the Chromium notices to a file a browser can open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'copse-about-open-'))
    try {
      const shipped = join(dir, 'licenses')
      mkdirSync(shipped)
      writeFileSync(join(shipped, 'LICENSES.chromium.html.gz'), gzipSync('<html>credits</html>'))
      writeFileSync(join(shipped, 'THIRD_PARTY_LICENSES.txt'), 'all')
      const temp = join(dir, 'tmp')
      const html = await openableLicenseFile('chromium', temp, shipped)
      assert.equal(html, join(temp, 'copse-licenses', 'LICENSES.chromium.html'))
      assert.equal(readFileSync(html, 'utf8'), '<html>credits</html>')
      assert.equal(
        await openableLicenseFile('third-party', temp, shipped),
        join(shipped, 'THIRD_PARTY_LICENSES.txt'),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
