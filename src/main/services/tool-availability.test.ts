import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkToolAvailability,
  isGhAvailable,
  isGitAvailable,
  isRgAvailable,
  probeGhAccessible,
  setGhAvailableForTest,
  setGitAvailableForTest,
  setRgAvailableForTest,
  type ToolAvailabilityDeps,
} from './tool-availability.ts'

/**
 * Probes that never resolve until released, so a test can observe how many the
 * caller started before any of them finished.
 */
function gatedDeps(): {
  deps: ToolAvailabilityDeps
  started: string[]
  release: () => void
} {
  const started: string[] = []
  let open: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  const mark = <T>(name: string, value: T) => {
    return async (): Promise<T> => {
      started.push(name)
      await gate
      return value
    }
  }
  return {
    deps: {
      probeRg: mark('rg', true),
      probeGit: mark('git', true),
      probeGh: mark('gh', true),
      probeGrepBackend: mark('grep', 'rg' as const),
      probeSemanticBackend: mark('semantic', 'gortex' as const),
    },
    started,
    release: () => open?.(),
  }
}

describe('checkToolAvailability', () => {
  beforeEach(() => {
    setRgAvailableForTest(null)
    setGitAvailableForTest(null)
    setGhAvailableForTest(null)
    delete process.env['COPSE_E2E']
  })

  // Each probe is a process spawn and `gh auth status` is a network round trip;
  // run serially they gated window creation for seconds (#995 timeline showed
  // 3290ms). Concurrency is the point of the change, so pin it: every probe must
  // have started before the first one is allowed to finish.
  it('starts every probe before any of them resolves', async () => {
    const { deps, started, release } = gatedDeps()
    const done = checkToolAvailability(deps)
    await Promise.resolve()
    assert.deepEqual(started.sort(), ['gh', 'git', 'grep', 'rg', 'semantic'])
    release()
    await done
  })

  // Promise.all destructuring is positional: swapping two entries would silently
  // report git's result as rg's, hiding or exposing the wrong tools.
  it('maps each probe result to its own flag', async () => {
    await checkToolAvailability({
      probeRg: () => Promise.resolve(true),
      probeGit: () => Promise.resolve(false),
      probeGh: () => Promise.resolve(true),
      probeGrepBackend: () => Promise.resolve('rg'),
      probeSemanticBackend: () => Promise.resolve(null),
    })
    assert.equal(isRgAvailable(), true)
    assert.equal(isGitAvailable(), false)
    assert.equal(isGhAvailable(), true)
  })

  it('skips every probe under e2e and assumes rg/git present, gh absent', async () => {
    process.env['COPSE_E2E'] = '1'
    const { deps, started } = gatedDeps()
    await checkToolAvailability(deps)
    assert.deepEqual(started, [])
    assert.equal(isRgAvailable(), true)
    assert.equal(isGitAvailable(), true)
    assert.equal(isGhAvailable(), false)
  })

  it('runs the authenticated GitHub probe outside the project sandbox', async () => {
    let invocation:
      { command: string; args: string[]; unsandboxed: boolean | undefined } | undefined
    const available = await probeGhAccessible((command, args, options) => {
      invocation = { command, args, unsandboxed: options?.unsandboxed }
      return Promise.resolve({ stdout: '', stderr: '', code: 0 })
    })

    assert.equal(available, true)
    assert.deepEqual(invocation, {
      command: 'gh',
      args: ['auth', 'status'],
      unsandboxed: true,
    })
  })

  it('treats a failed authenticated GitHub probe as unavailable', async () => {
    const available = await probeGhAccessible(() =>
      Promise.resolve({ stdout: '', stderr: 'not authenticated', code: 1 }),
    )
    assert.equal(available, false)
  })
})
