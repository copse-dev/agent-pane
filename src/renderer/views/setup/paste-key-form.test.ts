import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import '../../../../tests/setup-dom.ts'
import type { ApiClient } from '../../../preload/api.d.ts'
import { createFakeApi } from '../../fake-api.test-support.ts'
import { createPasteKeyForm, detectProviderFromKey } from './paste-key-form.ts'

describe('detectProviderFromKey', () => {
  it('recognises provider prefixes, longest first', () => {
    assert.deepEqual(detectProviderFromKey('sk-ant-api03-abcdef123456'), {
      provider: 'anthropic',
      certain: true,
    })
    assert.deepEqual(detectProviderFromKey('sk-or-v1-abcdef123456'), {
      provider: 'openrouter',
      certain: true,
    })
    assert.deepEqual(detectProviderFromKey('gsk_abcdef123456'), { provider: 'groq', certain: true })
    assert.deepEqual(detectProviderFromKey('AIzaSyabcdef123456'), {
      provider: 'gemini',
      certain: true,
    })
  })

  it('treats a bare sk- prefix as an uncertain OpenAI guess', () => {
    assert.deepEqual(detectProviderFromKey('sk-proj-abcdef123456'), {
      provider: 'openai',
      certain: false,
    })
  })

  it('returns null for unknown or too-short keys', () => {
    assert.equal(detectProviderFromKey('Zq81mXk93LpTt20abCdEf'), null)
    assert.equal(detectProviderFromKey('sk-ant-'), null)
    assert.equal(detectProviderFromKey('   '), null)
  })
})

interface Calls {
  validated: [string, string][]
  stored: [string, string][]
  saved: number
}

function mount(validateOk: (provider: string) => boolean): {
  root: HTMLElement
  calls: Calls
} {
  const base = createFakeApi()
  const calls: Calls = { validated: [], stored: [], saved: 0 }
  const api: ApiClient = {
    ...base,
    settings: {
      ...base.settings,
      validateKey: async (provider, key) => {
        calls.validated.push([provider, key])
        return validateOk(provider) ? { ok: true } : { ok: false, error: 'rejected' }
      },
      setKey: async (provider, key) => {
        calls.stored.push([provider, key])
        return { ok: true }
      },
    },
  }
  const form = createPasteKeyForm(api, {
    providers: () => [
      { id: 'anthropic', label: 'Anthropic' },
      { id: 'openai', label: 'OpenAI' },
      { id: 'groq', label: 'Groq' },
      { id: 'deepseek', label: 'DeepSeek' },
    ],
    onSaved: () => {
      calls.saved += 1
    },
    renderOther: () => document.createElement('div'),
  })
  document.body.append(form.root)
  return { root: form.root, calls }
}

function type(root: HTMLElement, value: string): void {
  const input = root.querySelector<HTMLInputElement>('[data-testid="paste-key-input"]')
  assert.ok(input)
  input.value = value
  input.dispatchEvent(new Event('input'))
}

const sel = (id: string): string => `[data-testid="${id}"]`

function must<T>(value: T | null): T {
  assert.ok(value)
  return value
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('paste key form', () => {
  it('detects the provider, validates, then stores the key', async () => {
    const { root, calls } = mount(() => true)
    assert.equal(must(root.querySelector<HTMLButtonElement>(sel('paste-key-save'))).disabled, true)
    type(root, 'sk-ant-api03-abcdef123456')
    assert.match(
      must(root.querySelector(sel('paste-key-hint'))).textContent,
      /Looks like an Anthropic key/,
    )
    assert.equal(must(root.querySelector<HTMLElement>(sel('paste-key-ask'))).hidden, true)
    must(root.querySelector<HTMLButtonElement>(sel('paste-key-save'))).click()
    await tick()
    await tick()
    assert.deepEqual(calls.validated, [['anthropic', 'sk-ant-api03-abcdef123456']])
    assert.deepEqual(calls.stored, [['anthropic', 'sk-ant-api03-abcdef123456']])
    assert.equal(calls.saved, 1)
    assert.equal(must(root.querySelector<HTMLInputElement>(sel('paste-key-input'))).value, '')
  })

  it('asks which provider an unrecognised key is for, and saves nothing until chosen', async () => {
    const { root, calls } = mount(() => true)
    type(root, 'Zq81mXk93LpTt20abCdEf')
    assert.equal(must(root.querySelector<HTMLElement>(sel('paste-key-ask'))).hidden, false)
    must(root.querySelector<HTMLButtonElement>(sel('paste-key-save'))).click()
    await tick()
    assert.deepEqual(calls.validated, [])
    const picker = must(root.querySelector<HTMLSelectElement>(sel('paste-key-provider')))
    picker.value = 'groq'
    picker.dispatchEvent(new Event('change'))
    must(root.querySelector<HTMLButtonElement>(sel('paste-key-save'))).click()
    await tick()
    await tick()
    assert.deepEqual(calls.stored, [['groq', 'Zq81mXk93LpTt20abCdEf']])
  })

  it('requires a provider choice before sending an ambiguous prefix', async () => {
    const { root, calls } = mount((provider) => provider !== 'openai')
    type(root, 'sk-abcdef1234567890')
    must(root.querySelector<HTMLButtonElement>(sel('paste-key-save'))).click()
    await tick()
    await tick()
    assert.deepEqual(calls.stored, [])
    assert.deepEqual(calls.validated, [])
    assert.equal(must(root.querySelector<HTMLElement>(sel('paste-key-ask'))).hidden, false)
    assert.match(
      must(root.querySelector(sel('paste-key-hint'))).textContent,
      /Choose which provider/,
    )
  })

  it('reports a rejected key from a certain prefix instead of asking', async () => {
    const { root, calls } = mount(() => false)
    type(root, 'gsk_abcdef123456')
    must(root.querySelector<HTMLButtonElement>(sel('paste-key-save'))).click()
    await tick()
    await tick()
    assert.deepEqual(calls.stored, [])
    assert.equal(must(root.querySelector<HTMLElement>(sel('paste-key-ask'))).hidden, true)
    assert.match(must(root.querySelector(sel('paste-key-hint'))).textContent, /rejected/)
  })
})

describe('paste key credential boundaries', () => {
  it('clears drafts and does not store a validation result after reset', async () => {
    const base = createFakeApi()
    let resolveCheck: (result: { ok: boolean }) => void = () => {}
    let stores = 0
    const api: ApiClient = {
      ...base,
      settings: {
        ...base.settings,
        validateKey: () =>
          new Promise((resolve) => {
            resolveCheck = resolve
          }),
        setKey: async () => {
          stores += 1
          return { ok: true }
        },
      },
    }
    const form = createPasteKeyForm(api, {
      providers: () => [{ id: 'anthropic', label: 'Anthropic' }],
      onSaved: () => {},
      renderOther: () => document.createElement('div'),
    })
    type(form.root, 'sk-ant-api03-abcdef123456')
    must(form.root.querySelector<HTMLButtonElement>(sel('paste-key-save'))).click()
    assert.equal(
      must(form.root.querySelector<HTMLInputElement>(sel('paste-key-input'))).disabled,
      true,
    )
    form.reset()
    resolveCheck({ ok: true })
    await tick()
    assert.equal(stores, 0)
    assert.equal(must(form.root.querySelector<HTMLInputElement>(sel('paste-key-input'))).value, '')
  })

  it('reports storage failure without leaking the exception or leaving the form locked', async () => {
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      settings: {
        ...base.settings,
        validateKey: async () => ({ ok: true }),
        setKey: async () => {
          throw new Error('secret-value-must-not-render')
        },
      },
    }
    const form = createPasteKeyForm(api, {
      providers: () => [{ id: 'anthropic', label: 'Anthropic' }],
      onSaved: () => assert.fail('not saved'),
      renderOther: () => document.createElement('div'),
    })
    type(form.root, 'sk-ant-api03-abcdef123456')
    must(form.root.querySelector<HTMLButtonElement>(sel('paste-key-save'))).click()
    await tick()
    assert.match(form.root.textContent, /Could not save the key/)
    assert.doesNotMatch(form.root.textContent, /secret-value/)
    assert.equal(
      must(form.root.querySelector<HTMLButtonElement>(sel('paste-key-save'))).disabled,
      false,
    )
  })
})
