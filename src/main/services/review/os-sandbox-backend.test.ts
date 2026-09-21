import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import type { CellSpec } from '@copse/review/isolation.ts'
import { createOsSandboxBackend, reviewCellSandboxOverlay } from './os-sandbox-backend.ts'

const spec: CellSpec = {
  checkouts: { base: '/tmp/review-cell/base', head: '/tmp/review-cell/head' },
  scratchDir: '/tmp/review-cell',
  readOnlyPaths: ['/store/pnpm', '/repo/.git'],
  env: { PATH: process.env['PATH'] ?? '', CI: '1' },
}

describe('reviewCellSandboxOverlay', () => {
  const overlay = reviewCellSandboxOverlay(spec)
  const fs = overlay.filesystem
  assert.ok(fs, 'overlay must define a filesystem config')

  it('denies all network', () => {
    assert.deepEqual(overlay.network, {
      allowedDomains: [],
      deniedDomains: [],
      allowLocalBinding: false,
    })
  })

  it('writes only inside the checkouts and scratch', () => {
    assert.deepEqual(fs.allowWrite, [
      '/tmp/review-cell/base',
      '/tmp/review-cell/base/**',
      '/tmp/review-cell/head',
      '/tmp/review-cell/head/**',
      '/tmp/review-cell',
      '/tmp/review-cell/**',
    ])
    for (const path of ['/store/pnpm', '/store/pnpm/**', '/repo/.git', '/repo/.git/**']) {
      assert.ok(fs.denyWrite.includes(path), `${path} must be write-denied`)
    }
    assert.ok(fs.denyWrite.includes('/tmp/review-cell/head/.git/hooks'))
  })

  it('denies the home directory and re-allows only the cell and its read-only paths', () => {
    assert.deepEqual(fs.denyRead, [homedir()])
    const allow = fs.allowRead ?? []
    for (const path of [
      '/tmp/review-cell/base/**',
      '/tmp/review-cell/head/**',
      '/tmp/review-cell/**',
      '/store/pnpm/**',
      '/repo/.git/**',
    ]) {
      assert.ok(allow.includes(path), `${path} must be readable`)
    }
    for (const path of allow) {
      assert.ok(
        !path.startsWith(homedir()) ||
          path.startsWith('/tmp/review-cell') ||
          path.startsWith('/store') ||
          path.startsWith('/repo') ||
          /\/node(\/|$)|\/bin\b|sandbox-runtime|apply-seccomp|\.nvm|fnm|\/versions\//.test(path),
        `${path} re-allows something under home that is not toolchain`,
      )
    }
  })
})

describe('createOsSandboxBackend', () => {
  it('is absent when ASRT is not active in this process', () => {
    // Nothing in the unit tier initialises the sandbox, so the honest answer
    // here is "no backend" — never a backend that claims a wall it lacks.
    assert.equal(createOsSandboxBackend(), null)
  })
})
