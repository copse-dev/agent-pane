import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCheckoutFile, writeCheckoutFile } from './checkout-fs.ts'

it('reads and writes nested checkout files without following file or directory links', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'review-safe-fs-'))
  const root = join(scratch, 'head')
  const outside = join(scratch, 'outside')
  await mkdir(root)
  await mkdir(outside)
  const canary = join(outside, 'canary.txt')
  await writeFile(canary, 'OUTSIDE_CANARY')
  try {
    writeCheckoutFile(root, '.copse-review/nested/test.cjs', 'first')
    assert.equal(readCheckoutFile(root, '.copse-review/nested/test.cjs'), 'first')
    writeCheckoutFile(root, '.copse-review/nested/test.cjs', 'second')
    assert.equal(readCheckoutFile(root, '.copse-review/nested/test.cjs'), 'second')
    await symlink(outside, join(root, 'linked'), 'junction')
    assert.throws(() => readCheckoutFile(root, 'linked/canary.txt'), /Symlink/)
    assert.throws(() => writeCheckoutFile(root, 'linked/canary.txt', 'escaped'))
    assert.throws(() => writeCheckoutFile(root, '../outside/canary.txt', 'escaped'), /outside/)
    await symlink(canary, join(root, '.copse-review/file-link'), 'file')
    assert.throws(() => readCheckoutFile(root, '.copse-review/file-link'), /Symlink/)
    assert.throws(() => writeCheckoutFile(root, '.copse-review/file-link', 'escaped'))
    assert.equal(await readFile(canary, 'utf8'), 'OUTSIDE_CANARY')
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

it('refuses to buffer an oversized checkout file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-safe-fs-big-'))
  try {
    await writeFile(join(root, 'big'), '')
    // Sparse: executed code can do this in one call to exhaust the orchestrator.
    await truncate(join(root, 'big'), 64 * 1024 * 1024)
    assert.throws(() => readCheckoutFile(root, 'big'), /too large to read/)
    await writeFile(join(root, 'small'), 'ok')
    assert.equal(readCheckoutFile(root, 'small'), 'ok')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
