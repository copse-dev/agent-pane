import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountSettingsDialog } from './settings-dialog.ts'
import { mountApprovalDialog } from './approval-dialog.ts'
import { resetAttention } from '../controller/attention.ts'
import { qsRequired } from '../dom/helpers.ts'
import { createPendingApi } from '../fake-api.test-support.ts'

type ApprovalHandler = (req: {
  id: string
  threadId?: string
  title: string
  body: string
  type: string
  allowRemember?: boolean
  rememberLabel?: string
  comparisonModels?: { a: string; b: string; judge: string }
}) => void

type Responded = {
  id: string
  approved: boolean
  remember: boolean
  comparisonModels?: { a: string; b: string; judge: string }
}

function makeApi(): {
  api: ApiClient
  emit: (req: Record<string, unknown>) => void
  responses: Responded[]
} {
  let handler: ApprovalHandler = () => {}
  const responses: Responded[] = []
  const overrides = {
    'agent.onApprovalRequest': (h: ApprovalHandler): (() => void) => {
      handler = h
      return () => {}
    },
    'approval.respond': (
      id: string,
      approved: boolean,
      remember: boolean,
      comparisonModels?: { a: string; b: string; judge: string },
    ): Promise<void> => {
      const entry: Responded = { id, approved, remember }
      if (comparisonModels) entry.comparisonModels = comparisonModels
      responses.push(entry)
      return Promise.resolve()
    },
    'settings.availableProviders': (): Promise<{
      anthropic: boolean
      openai: boolean
      openrouter: boolean
    }> => Promise.resolve({ anthropic: true, openai: true, openrouter: false }),
    'lmStudio.models': (): Promise<string[]> => Promise.resolve([]),
  }
  const api = createPendingApi(overrides)
  return {
    api,
    responses,
    emit: (req): void => {
      handler({
        id: String(req['id']),
        title: 'Compare models on this diff?',
        body: 'Each reviewer independently reads the working diff; a judge compares their verdicts.',
        type: 'model-compare',
        allowRemember: true,
        rememberLabel: 'Always run comparisons in this chat',
        comparisonModels: {
          a: 'claude-sonnet-4-6',
          b: 'claude-opus-4-8',
          judge: 'claude-opus-4-8',
        },
        ...req,
      })
    },
  }
}

function shimDialog(dialog: HTMLDialogElement): void {
  let open = false
  Object.defineProperties(dialog, {
    show: {
      configurable: true,
      value: () => {
        open = true
      },
    },
    close: {
      configurable: true,
      value: () => {
        open = false
      },
    },
    open: { configurable: true, get: () => open },
  })
}

describe('approval dialog model comparison pickers', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    resetAttention()
  })

  it('shows model pickers and returns the selected models on approve', async () => {
    const { api, emit, responses } = makeApi()
    const store = createStore()
    mountSettingsDialog(store, api)
    mountApprovalDialog(api, store, {
      setTimer: (fn): (() => void) => {
        fn()
        return () => {}
      },
    })
    const dialog = qsRequired<HTMLDialogElement>(document, '#approval-dialog')
    shimDialog(dialog)

    emit({ id: 'cmp-1' })

    const pickers = dialog.querySelector('.approval-comparison-models')
    assert.ok(pickers, 'expected comparison model pickers')
    assert.equal(dialog.querySelectorAll('.approval-model-select').length, 3)
    assert.equal(dialog.querySelectorAll('.approval-model-picker').length, 3)

    const selects = [...dialog.querySelectorAll<HTMLSelectElement>('.approval-model-select')]
    assert.equal(selects.length, 3)
    const selectA = selects[0]
    const selectB = selects[1]
    const selectJudge = selects[2]
    assert.ok(selectA && selectB && selectJudge)
    const fillSelect = (select: HTMLSelectElement, value: string): void => {
      select.innerHTML = ''
      const option = document.createElement('option')
      option.value = value
      option.textContent = value
      select.append(option)
      select.value = value
    }
    fillSelect(selectA, 'claude-sonnet-4-6')
    fillSelect(selectB, 'gpt-5')
    fillSelect(selectJudge, 'claude-opus-4-8')

    dialog.querySelector<HTMLButtonElement>('.approval-approve')?.click()

    assert.equal(responses.length, 1)
    assert.deepEqual(responses[0], {
      id: 'cmp-1',
      approved: true,
      remember: false,
      comparisonModels: {
        a: 'claude-sonnet-4-6',
        b: 'gpt-5',
        judge: 'claude-opus-4-8',
      },
    })
  })
})
