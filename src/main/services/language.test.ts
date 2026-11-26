import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectLanguage } from './language.ts'

describe('detectLanguage', () => {
  it('maps known extensions and the extensionless build files', () => {
    assert.equal(detectLanguage('src/main/index.ts'), 'typescript')
    assert.equal(detectLanguage('scripts/build.MJS'), 'javascript')
    assert.equal(detectLanguage('docker/Dockerfile'), 'dockerfile')
    assert.equal(detectLanguage('Makefile'), 'makefile')
    assert.equal(detectLanguage('notes.unknown'), 'plaintext')
  })

  // The extension is file-controlled and the table is an object literal, so a
  // plain index would hand back `Object.prototype` members for these names: a
  // function or an object where every caller expects a language id string.
  it('treats names that collide with Object.prototype as plain text', () => {
    for (const path of ['src/constructor', 'lib/shim.constructor', '__proto__', 'a.__proto__']) {
      assert.equal(detectLanguage(path), 'plaintext', path)
    }
  })
})
