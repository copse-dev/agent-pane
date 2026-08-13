import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

type ExtractZip = (zipPath: string, options: { dir: string }) => Promise<void>

const FIXTURE_ZIP =
  'UEsDBAoAAAAAADEJDV0rrg4ECAAAAAgAAAALABwAZml4dHVyZS50eHRVVAkAAz0LfWo9C31qdXgLAAEE9QEAAAQAAAAAMjIuMTguMApQSwECHgMKAAAAAAAxCQ1dK64OBAgAAAAIAAAACwAYAAAAAAABAAAApIEAAAAAZml4dHVyZS50eHRVVAUAAz0LfWp1eAsAAQT1AQAABAAAAABQSwUGAAAAAAEAAQBRAAAATQAAAAAA'

function isExtractZip(value: unknown): value is ExtractZip {
  return typeof value === 'function'
}

test('exposes a CommonJS-compatible secure ZIP extractor', async () => {
  const requireFromRepo = createRequire(resolve('package.json'))
  const extractZip: unknown = requireFromRepo('extract-zip')
  assert.ok(isExtractZip(extractZip))

  const root = await mkdtemp(join(tmpdir(), 'copse-extract-zip-'))
  try {
    const archive = join(root, 'fixture.zip')
    const output = join(root, 'output')
    await writeFile(archive, Buffer.from(FIXTURE_ZIP, 'base64'))
    await extractZip(archive, { dir: output })
    assert.equal(await readFile(join(output, 'fixture.txt'), 'utf8'), '22.18.0\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
