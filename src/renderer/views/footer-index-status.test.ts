import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../preload/api.d.ts'
import type { WorkspaceIndexStatus } from '@shared/types/index-status.ts'
import { mountFooterIndexStatus } from './footer-index-status.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

type StatusHandler = (status: WorkspaceIndexStatus) => void

function makeApi(initial: WorkspaceIndexStatus): {
  api: ApiClient
  push: StatusHandler
} {
  let handler: StatusHandler = () => undefined
  const api = ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      index: {
        ...base['index'],
        status: () => Promise.resolve(initial),
        onStatusChanged: (h: StatusHandler): (() => void) => {
          handler = h
          return () => undefined
        },
      },
    } satisfies ApiClient
  })()
  return {
    api,
    push: (status): void => {
      handler(status)
    },
  }
}

const idle: WorkspaceIndexStatus = {
  fileIndex: { phase: 'idle' },
  semantic: { phase: 'idle' },
}

function building(startedAgoMs: number): WorkspaceIndexStatus {
  return {
    fileIndex: { phase: 'ready' },
    semantic: { phase: 'building', startedAt: Date.now() - startedAgoMs },
  }
}

let destroy: (() => void) | undefined

afterEach(() => {
  destroy?.()
  destroy = undefined
  document.body.replaceChildren()
})

function chipEl(): HTMLElement {
  const chip = document.body.querySelector<HTMLElement>('.footer-indexing')
  assert.ok(chip)
  return chip
}

describe('footer index status chip', () => {
  it('stays hidden while nothing is building', async () => {
    const { api } = makeApi(idle)
    destroy = mountFooterIndexStatus(document.body, api).destroy
    await Promise.resolve()
    assert.equal(chipEl().hidden, true)
  })

  it('shows elapsed time for a long-running build', () => {
    const { api, push } = makeApi(idle)
    destroy = mountFooterIndexStatus(document.body, api).destroy
    push(building(65_000))
    const chip = chipEl()
    assert.equal(chip.hidden, false)
    assert.match(chip.textContent, /^Indexing… 1m \d+s$/)
    assert.equal(chip.dataset['state'], 'building')
    assert.match(chip.title, /semantic code index: building/)
  })

  it('suppresses sub-second rebuild flicker', () => {
    const { api, push } = makeApi(idle)
    destroy = mountFooterIndexStatus(document.body, api).destroy
    push(building(100))
    assert.equal(chipEl().hidden, true)
  })

  it('hides again when the build completes', () => {
    const { api, push } = makeApi(idle)
    destroy = mountFooterIndexStatus(document.body, api).destroy
    push(building(65_000))
    assert.equal(chipEl().hidden, false)
    push({ fileIndex: { phase: 'ready' }, semantic: { phase: 'ready' } })
    assert.equal(chipEl().hidden, true)
  })

  it('reports a failed build until a later one succeeds', () => {
    const { api, push } = makeApi(idle)
    destroy = mountFooterIndexStatus(document.body, api).destroy
    push({ fileIndex: { phase: 'error' }, semantic: { phase: 'ready' } })
    const chip = chipEl()
    assert.equal(chip.hidden, false)
    assert.equal(chip.textContent, 'Indexing failed')
    assert.equal(chip.dataset['state'], 'error')
    push({ fileIndex: { phase: 'ready' }, semantic: { phase: 'ready' } })
    assert.equal(chip.hidden, true)
  })

  it('seeds from the pulled status when a build predates the mount', async () => {
    const { api } = makeApi(building(30_000))
    destroy = mountFooterIndexStatus(document.body, api).destroy
    await Promise.resolve()
    await Promise.resolve()
    const chip = chipEl()
    assert.equal(chip.hidden, false)
    assert.match(chip.textContent, /^Indexing… 30s$/)
  })

  it('treats a semantic backend as absent without showing the chip', () => {
    const { api, push } = makeApi(idle)
    destroy = mountFooterIndexStatus(document.body, api).destroy
    push({ fileIndex: { phase: 'ready' }, semantic: { phase: 'unavailable' } })
    assert.equal(chipEl().hidden, true)
  })

  it('labels a file-only build distinctly when semantic is unavailable (SSH)', () => {
    const { api, push } = makeApi(idle)
    destroy = mountFooterIndexStatus(document.body, api).destroy
    push({
      fileIndex: { phase: 'building', startedAt: Date.now() - 20_000 },
      semantic: { phase: 'unavailable' },
    })
    const chip = chipEl()
    assert.equal(chip.hidden, false)
    assert.match(chip.textContent, /^Building file index… 20s$/)
    assert.match(chip.title, /semantic code index: unavailable/)
    assert.doesNotMatch(chip.title, /no backend installed/)
  })
})
