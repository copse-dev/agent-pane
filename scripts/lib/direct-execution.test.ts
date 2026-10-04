import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { it } from 'node:test'
import { isDirectExecution } from './direct-execution.mts'

it('identifies the same file, relative paths, and a symlinked entrypoint', () => {
  const directory = mkdtempSync(join(tmpdir(), 'copse-entrypoint-'))
  try {
    const module = join(directory, 'command.mts')
    const other = join(directory, 'other.mts')
    const alias = join(directory, 'alias.mts')
    writeFileSync(module, '')
    writeFileSync(other, '')
    symlinkSync(module, alias)
    const url = pathToFileURL(module).href
    assert.equal(isDirectExecution(url, 'command', undefined, module), true)
    assert.equal(isDirectExecution(url, 'command', undefined, alias), true)
    assert.equal(
      isDirectExecution(url, 'command', undefined, relative(process.cwd(), module)),
      true,
    )
    assert.equal(isDirectExecution(url, 'command', undefined, other), false)
    assert.equal(isDirectExecution(url, 'imported-command', undefined, module), false)
    assert.equal(isDirectExecution(undefined, 'command', module, alias), true)
    assert.equal(isDirectExecution(undefined, 'command', undefined, module), false)
    assert.equal(isDirectExecution(url, 'command', undefined, join(directory, 'missing')), false)
    assert.equal(isDirectExecution('not a file URL', 'command', undefined, module), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
