import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { isCompiledProgram, readScriptForHarm } from './script-files.ts'

const dir = mkdtempSync(join(tmpdir(), 'script-files-'))
after(() => {
  rmSync(dir, { recursive: true, force: true })
})

function file(name: string, contents: string | Buffer): string {
  const path = join(dir, name)
  writeFileSync(path, contents)
  return path
}

describe('readScriptForHarm', () => {
  it('reads a text script', () => {
    assert.equal(readScriptForHarm(file('run.sh', 'echo hi\n')), 'echo hi\n')
  })

  it('returns null for binary, oversized, missing, and non-file paths', () => {
    assert.equal(readScriptForHarm(file('app', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]))), null)
    assert.equal(readScriptForHarm(file('big.sh', 'x'.repeat(256 * 1024 + 1))), null)
    assert.equal(readScriptForHarm(join(dir, 'missing')), null)
    assert.equal(readScriptForHarm(dir), null)
  })
})

describe('isCompiledProgram', () => {
  it('recognises ELF, Mach-O, and PE headers', () => {
    assert.equal(isCompiledProgram(file('elf', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2]))), true)
    assert.equal(isCompiledProgram(file('macho', Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))), true)
    assert.equal(isCompiledProgram(file('fat', Buffer.from([0xca, 0xfe, 0xba, 0xbe]))), true)
    assert.equal(isCompiledProgram(file('pe', Buffer.from('MZ\x90\x00'))), true)
  })

  it('rejects text, other binaries, short files, directories, and missing paths', () => {
    assert.equal(isCompiledProgram(file('script', '#!/bin/sh\necho hi\n')), false)
    assert.equal(isCompiledProgram(file('png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))), false)
    assert.equal(isCompiledProgram(file('short', Buffer.from([0x7f]))), false)
    assert.equal(isCompiledProgram(dir), false)
    assert.equal(isCompiledProgram(join(dir, 'missing')), false)
  })
})
