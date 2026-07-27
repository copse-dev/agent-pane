import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ghCliBackend } from './github/backend/gh-cli-backend.ts'
import {
  checkToolAvailability,
  isGitAvailable,
  isGitAvailableForTarget,
  isRgAvailableForTarget,
  resetToolAvailabilityProbeForTest,
  setGhAvailableForTest,
  setGitAvailableForTest,
  setRgAvailableForTest,
  type ToolAvailabilityDeps,
} from './tool-availability.ts'

/**
 * Separate file from `tool-availability.test.ts` deliberately: the readiness
 * promise is module state, and the suites there call `checkToolAvailability()`
 * for their own reasons. Sharing a process would let their probe satisfy the
 * wait these tests are trying to observe. `node --test` gives each file its own
 * process, so this is the isolation.
 */

/** A probe set that stays in flight until `release()` is called. */
function gatedDeps(options: { ghAvailable?: boolean } = {}): {
  deps: ToolAvailabilityDeps
  release: () => void
} {
  let open: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  const gated = <T>(value: T) => {
    return async (): Promise<T> => {
      await gate
      return value
    }
  }
  return {
    deps: {
      probeRg: gated(true),
      probeGit: gated(true),
      probeGh: gated(options.ghAvailable ?? true),
      probeGrepBackend: gated('rg' as const),
      probeSemanticBackend: gated('gortex' as const),
    },
    release: () => open?.(),
  }
}

describe('probe readiness', () => {
  beforeEach(() => {
    resetToolAvailabilityProbeForTest()
    setRgAvailableForTest(null)
    setGitAvailableForTest(null)
    setGhAvailableForTest(null)
  })

  // Startup registers IPC handlers *before* awaiting the probe, so the renderer
  // (already loading by then) never invokes an unregistered channel. That means
  // a first-paint git or search request can land while the probe is still out.
  // The synchronous getters read an unprobed `null` as false, so without this
  // wait the renderer would be told "git is not available" on a machine that has
  // git — and nothing would re-ask. This wait is what makes moving handler
  // registration ahead of the probe safe.
  it('makes the git helper wait for an in-flight probe', async () => {
    const { deps, release } = gatedDeps()
    const probe = checkToolAvailability(deps)

    let settled = false
    const pending = isGitAvailableForTarget({ kind: 'local' }).then((value) => {
      settled = true
      return value
    })

    // The unprobed synchronous getter is exactly the wrong answer we must not
    // hand back while the probe is still out.
    assert.equal(isGitAvailable(), false)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    assert.equal(settled, false, 'expected the helper to wait for the probe')

    release()
    await probe
    assert.equal(await pending, true)
  })

  it('makes the ripgrep helper wait for an in-flight probe', async () => {
    const { deps, release } = gatedDeps()
    const probe = checkToolAvailability(deps)

    let settled = false
    const pending = isRgAvailableForTarget({ kind: 'local' }).then((value) => {
      settled = true
      return value
    })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    assert.equal(settled, false, 'expected the helper to wait for the probe')

    release()
    await probe
    assert.equal(await pending, true)
  })

  it('makes the PR backend status wait for an in-flight probe', async () => {
    const { deps, release } = gatedDeps({ ghAvailable: false })
    const probe = checkToolAvailability(deps)

    let settled = false
    const pending = ghCliBackend.getStatus().then((status) => {
      settled = true
      return status
    })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    assert.equal(settled, false, 'expected PR status to wait for the probe')

    release()
    await probe
    const status = await pending
    assert.equal(status.installed, false)
    assert.equal(status.authenticated, false)
  })

  // Unit tests (and the ACP headless path) never run the startup probe. They
  // must not block on a promise nothing will resolve.
  it('resolves immediately when no probe was ever started', async () => {
    setGitAvailableForTest(true)
    setRgAvailableForTest(false)
    assert.equal(await isGitAvailableForTarget({ kind: 'local' }), true)
    assert.equal(await isRgAvailableForTarget({ kind: 'local' }), false)
  })
})
