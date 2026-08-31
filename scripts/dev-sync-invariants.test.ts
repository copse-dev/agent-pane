import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const makefile = readFileSync('Makefile', 'utf8')
const devScript = readFileSync('scripts/dev.mts', 'utf8')

describe('content-addressed development launcher', () => {
  it('routes dependency and build targets through the sync script', () => {
    assert.match(makefile, /DEV_SYNC := node scripts\/sync-dev\.mts/)
    assert.match(makefile, /deps: check-node\n\t@\$\(USE_NVM\); \$\(DEV_SYNC\) deps/)
    assert.match(makefile, /build: check-node\n\t@\$\(USE_NVM\); \$\(DEV_SYNC\) build/)
  })

  it('does not mutate or validate app state while Make parses the file', () => {
    assert.doesNotMatch(makefile, /DEPS_STAMP|BUILD_STAMP|SRC_LIST_STAMP/)
    assert.doesNotMatch(makefile, /\$\(shell (?:if|find|mkdir|rm|echo|cat)\b/)
    assert.doesNotMatch(makefile, /\s-nt\s|touch .*stamp/)
  })

  it('invalidates one-shot output state before watch mode writes dist', () => {
    assert.match(devScript, /rmSync\('dist\/\.copse-build-fingerprint', \{ force: true \}\)/)
  })
})
