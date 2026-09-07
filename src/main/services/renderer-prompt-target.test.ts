import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  currentRendererPromptTarget,
  resolveRendererPromptTarget,
  runWithRendererPromptTarget,
  type RendererPromptTarget,
} from './renderer-prompt-target.ts'

interface MockTarget extends RendererPromptTarget {
  id: string
  sent: [string, ...unknown[]][]
  markDestroyed: () => void
}

function mockTarget(id: string): MockTarget {
  let destroyed = false
  const sent: [string, ...unknown[]][] = []
  return {
    id,
    sent,
    markDestroyed(): void {
      destroyed = true
    },
    isDestroyed: (): boolean => destroyed,
    send(channel: string, ...args: unknown[]): void {
      sent.push([channel, ...args])
    },
  }
}

describe('renderer prompt target', () => {
  it('defaults to the main-window fallback', () => {
    const main = mockTarget('main')
    assert.equal(resolveRendererPromptTarget(main), main)
  })

  it('routes to the renderer that opened the prompt, and only inside the scope', () => {
    const main = mockTarget('main')
    const popout = mockTarget('popout')
    runWithRendererPromptTarget(popout, () => {
      assert.equal(resolveRendererPromptTarget(main), popout)
    })
    assert.equal(resolveRendererPromptTarget(main), main)
  })

  it('falls back when the requesting renderer is already gone', () => {
    // A pop-out closed while its own prompt was being prepared. Sending into a
    // destroyed renderer would leave the caller waiting on an answer nobody can
    // give, so the main window takes it.
    const main = mockTarget('main')
    const popout = mockTarget('popout')
    popout.markDestroyed()
    runWithRendererPromptTarget(popout, () => {
      assert.equal(resolveRendererPromptTarget(main), main)
    })
  })

  it('holds the scope across awaits, so a later prompt in the same call still lands', async () => {
    // The reason the whole `terminal:create` handler is scoped rather than just
    // its permission check: the second question (a passphrase, a host key) is
    // raised several awaits after the first.
    const main = mockTarget('main')
    const popout = mockTarget('popout')
    await runWithRendererPromptTarget(popout, async () => {
      assert.equal(resolveRendererPromptTarget(main), popout)
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(resolveRendererPromptTarget(main), popout)
    })
    assert.equal(resolveRendererPromptTarget(main), main)
  })

  it('nests, so an inner scope wins and the outer one is restored', () => {
    const main = mockTarget('main')
    const outer = mockTarget('outer')
    const inner = mockTarget('inner')
    runWithRendererPromptTarget(outer, () => {
      runWithRendererPromptTarget(inner, () => {
        assert.equal(resolveRendererPromptTarget(main), inner)
      })
      assert.equal(resolveRendererPromptTarget(main), outer)
    })
  })

  describe('currentRendererPromptTarget', () => {
    it('is null with nothing scoped, so work with no window behind it says so', () => {
      // A background agent run leases SSH credentials too; it has no originating
      // renderer, and must not be given one by accident.
      assert.equal(currentRendererPromptTarget(), null)
    })

    it('returns the scoped renderer, for capture across an async boundary', () => {
      const popout = mockTarget('popout')
      runWithRendererPromptTarget(popout, () => {
        assert.equal(currentRendererPromptTarget(), popout)
      })
    })

    it('reports a destroyed renderer as nothing to capture', () => {
      const popout = mockTarget('popout')
      popout.markDestroyed()
      runWithRendererPromptTarget(popout, () => {
        assert.equal(currentRendererPromptTarget(), null)
      })
    })
  })
})
