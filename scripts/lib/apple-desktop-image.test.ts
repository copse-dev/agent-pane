import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Script } from 'node:vm'
import { spawnSync } from 'node:child_process'
import { APPLE_DESKTOP_READY_EXPRESSION } from './apple-desktop-ready.mts'
import { APPLE_DESKTOP_BOOTSTRAP } from './apple-desktop-bootstrap.mts'
import {
  APPLE_DESKTOP_BUILD_INPUTS,
  APPLE_DESKTOP_DOCKERFILE,
  copyAppleDesktopInput,
} from './apple-desktop-image.mts'
import { decodeAppleDesktopRequest } from './apple-desktop-wire.mts'

describe('Apple desktop build and input boundary', () => {
  it('ships syntactically valid renderer readiness JavaScript', () => {
    assert.doesNotThrow(() => {
      new Script(APPLE_DESKTOP_READY_EXPRESSION)
      new Script(APPLE_DESKTOP_BOOTSTRAP)
    })
  })
  it('loads the bounded controller transfer inside its receiving process and refuses malformed input', () => {
    const source = "process.stdout.write('controller-loaded')"
    const loaded = spawnSync(process.execPath, ['-e', APPLE_DESKTOP_BOOTSTRAP], {
      input: Buffer.from(source).toString('base64') + '\n',
      encoding: 'utf8',
      timeout: 5000,
    })
    assert.equal(loaded.status, 0, loaded.stderr)
    assert.equal(loaded.stdout, 'controller-loaded')
    const invalid = spawnSync(process.execPath, ['-e', APPLE_DESKTOP_BOOTSTRAP], {
      input: 'invalid!\n',
      encoding: 'utf8',
      timeout: 5000,
    })
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stderr, /Invalid desktop controller encoding/)
  })
  it('accepts a fresh-profile welcome screen and rejects an empty or wrongly sized renderer', async () => {
    const observe = async (selectors: string[], width = 1280): Promise<unknown> => {
      const result: unknown = await new Script(APPLE_DESKTOP_READY_EXPRESSION).runInNewContext({
        innerWidth: width,
        innerHeight: 800,
        requestAnimationFrame: (callback: () => void): void => {
          callback()
        },
        getComputedStyle: () => ({ visibility: 'visible' }),
        document: {
          readyState: 'complete',
          querySelector: (selector: string) =>
            selectors.includes(selector)
              ? { getBoundingClientRect: () => ({ width: 100, height: 100 }) }
              : null,
        },
      })
      return structuredClone(result)
    }
    assert.deepEqual(await observe(['#welcome.visible .welcome-card']), {
      ready: true,
      width: 1280,
      height: 800,
      composer: false,
      onboarding: false,
      welcome: true,
    })
    assert.deepEqual(await observe([]), {
      ready: false,
      width: 1280,
      height: 800,
      composer: false,
      onboarding: false,
      welcome: false,
    })
    assert.deepEqual(await observe(['.prompt-input'], 1200), {
      ready: false,
      width: 1200,
      height: 800,
      composer: true,
      onboarding: false,
      welcome: false,
    })
  })
  it('stages regular files but excludes host dependencies and hidden state', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-desktop-input-'))
    try {
      const source = join(root, 'source')
      mkdirSync(join(source, 'node_modules'), { recursive: true })
      writeFileSync(join(source, 'app.js'), 'app')
      writeFileSync(join(source, '.env'), 'not copied')
      writeFileSync(join(source, 'node_modules', 'host.node'), 'not copied')
      const destination = join(root, 'context')
      copyAppleDesktopInput(source, destination)
      assert.equal(readFileSync(join(destination, 'app.js'), 'utf8'), 'app')
      assert.equal(existsSync(join(destination, '.env')), false)
      assert.equal(existsSync(join(destination, 'node_modules')), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('refuses a symlink rather than copying bytes from outside the declared inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-desktop-link-'))
    try {
      writeFileSync(join(root, 'outside'), 'private')
      mkdirSync(join(root, 'source'))
      symlinkSync(join(root, 'outside'), join(root, 'source', 'link'))
      assert.throws(() => {
        copyAppleDesktopInput(join(root, 'source'), join(root, 'context'))
      }, /symbolic link/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('uses a locked install and unprivileged, no-new-privileges entrypoint', () => {
    assert.match(APPLE_DESKTOP_DOCKERFILE, /pnpm install --frozen-lockfile --ignore-scripts/)
    assert.match(APPLE_DESKTOP_DOCKERFILE, /USER 1001:1001/)
    assert.match(APPLE_DESKTOP_DOCKERFILE, /--no-new-privs/)
    assert.equal(
      APPLE_DESKTOP_BUILD_INPUTS.some(
        (input) => input.includes('node_modules') || input.includes('.copse'),
      ),
      false,
    )
  })
  it('accepts only bounded desktop inputs and never an arbitrary command', () => {
    assert.deepEqual(decodeAppleDesktopRequest('{"action":"click","x":10,"y":20}'), {
      action: 'click',
      x: 10,
      y: 20,
      button: 1,
    })
    for (const request of [
      { action: 'shell', command: 'id' },
      { action: 'click', x: -1, y: 0 },
      { action: 'click', x: 1280, y: 800 },
      { action: 'type', text: 'x'.repeat(2001) },
      { action: 'key', key: '--window=1' },
      { action: 'screenshot', path: '/host/file' },
    ])
      assert.throws(() => decodeAppleDesktopRequest(JSON.stringify(request)))
    assert.throws(() => decodeAppleDesktopRequest(' '.repeat(17 * 1024)), /too large/)
    assert.deepEqual(decodeAppleDesktopRequest('{"action":"key","key":"ctrl+shift+a"}'), {
      action: 'key',
      key: 'ctrl+shift+a',
    })
  })
})
