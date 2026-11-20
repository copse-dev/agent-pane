import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WebFrameMain } from 'electron'
import { ipcFrame } from '../../../tests/helpers/ipc-frame.ts'
import type { SkillsSourcesResult } from '@shared/types/skills.ts'
import { registerTrustedAppFrame, unregisterTrustedAppFrame } from '../windows/app-frames.ts'
import { IpcValidationError } from './ipc-guards.ts'
import { createSkillRootsHandler } from './skill-roots-handler.ts'

function harness(): {
  handler: ReturnType<typeof createSkillRootsHandler>
  mainFrame: WebFrameMain
  effects: string[]
  sources: SkillsSourcesResult
  saved: () => unknown
} {
  const mainFrame = ipcFrame()
  const win = { isDestroyed: (): boolean => false, webContents: { mainFrame } }
  const effects: string[] = []
  let saved: unknown = ['/original']
  const sources: SkillsSourcesResult = {
    skills: [],
    diagnostics: [],
    extraRoots: ['/extra'],
    reload: 'manual',
  }
  const handler = createSkillRootsHandler(win, {
    setSetting: async (key, value) => {
      effects.push(key)
      saved = value
    },
    initSkillsRegistry: async () => {
      effects.push('refresh')
    },
    listSkillSources: () => {
      effects.push('list')
      return sources
    },
  })
  return { handler, mainFrame, effects, sources, saved: (): unknown => saved }
}

describe('skills:set-roots sender boundary', () => {
  it('rejects untrusted senders before validation, persistence or discovery', async () => {
    const h = harness()
    for (const senderFrame of [null, ipcFrame(), ipcFrame(h.mainFrame), ipcFrame()]) {
      for (const value of [['/attacker'], null]) {
        await assert.rejects(
          h.handler({ senderFrame }, value),
          /Request rejected: it did not come from the app window/,
        )
      }
    }
    assert.deepEqual(h.saved(), ['/original'])
    assert.deepEqual(h.effects, [])
  })

  it('validates trusted payloads before effects and keeps persistence/refresh/list ordering', async () => {
    const h = harness()
    await assert.rejects(h.handler({ senderFrame: h.mainFrame }, ['relative']), IpcValidationError)
    assert.deepEqual(h.effects, [])
    assert.equal(await h.handler({ senderFrame: h.mainFrame }, [' /extra ', '/extra']), h.sources)
    assert.deepEqual(h.saved(), ['/extra'])
    assert.deepEqual(h.effects, ['skillPluginPaths', 'refresh', 'list'])
  })

  it('accepts another registered app frame without weakening unregistered sender rejection', async () => {
    const h = harness()
    const additional = ipcFrame()
    registerTrustedAppFrame(additional)
    try {
      await h.handler({ senderFrame: additional }, [])
    } finally {
      unregisterTrustedAppFrame(additional)
    }
    assert.deepEqual(h.saved(), [])
    await assert.rejects(h.handler({ senderFrame: additional }, ['/attacker']), IpcValidationError)
    assert.deepEqual(h.effects, ['skillPluginPaths', 'refresh', 'list'])
  })

  it('does not refresh discovery after a failed settings write', async () => {
    const mainFrame = ipcFrame()
    const win = { isDestroyed: (): boolean => false, webContents: { mainFrame } }
    const handler = createSkillRootsHandler(win, {
      setSetting: async () => {
        throw new Error('disk failure')
      },
      initSkillsRegistry: async () => {
        assert.fail('must not refresh after failed persistence')
      },
      listSkillSources: () => assert.fail('must not list after failed persistence'),
    })
    await assert.rejects(handler({ senderFrame: mainFrame }, []), /disk failure/)
  })
})
