import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { getAppVersion } from './app-version.ts'

describe('Copse source and release versions', async () => {
  const runtime = { isPackaged: false, getVersion: (): string => '44.4.3' }

  it('reads the source package relative to the actual bundled main directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'copse-version-'))
    const main = join(directory, 'dist', 'main')
    mkdirSync(main, { recursive: true })
    try {
      writeFileSync(
        join(directory, 'package.json'),
        '{"name":"copse-panel","version":"0.1.0-beta.13"}',
      )
      assert.equal(await getAppVersion(runtime, main), '0.1.0-beta.13')
      assert.equal(await getAppVersion({ ...runtime, isPackaged: true }, main), '44.4.3')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('falls back for missing, malformed, blank or non-string package versions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'copse-version-invalid-'))
    const main = join(directory, 'dist', 'main')
    mkdirSync(main, { recursive: true })
    try {
      assert.equal(await getAppVersion(runtime, main), '44.4.3')
      for (const text of [
        '{',
        'null',
        '[]',
        '{}',
        '{"version":9}',
        '{"version":""}',
        '{"version":"  "}',
      ]) {
        writeFileSync(join(directory, 'package.json'), text)
        assert.equal(await getAppVersion(runtime, main), '44.4.3', text)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not read source metadata for a packaged release', async () => {
    assert.equal(
      await getAppVersion({ isPackaged: true, getVersion: () => '0.2.0' }, '/missing/dist/main'),
      '0.2.0',
    )
  })
})
