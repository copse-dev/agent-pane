// The provider key field is write-only: a saved key is never read back into the
// input, so before this the Test key button could only check a key being typed.
// A provider configured in an earlier session had a key on file the button
// refused to test — it answered "Enter a key first" over a key that was set.
import '../../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient, ExtraProvider } from '../../../preload/api.d.ts'
import { createFakeApi } from '../../fake-api.test-support.ts'
import { createCustomProvidersSection } from './custom-providers-section.ts'

type ValidateResult = { ok: boolean; error?: string; formatOk?: boolean }

function stubApi(
  stored: readonly string[],
  calls: [string, string][],
  result: ValidateResult = { ok: true },
): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    settings: {
      ...base.settings,
      get: async (): Promise<unknown> => null,
      getKey: async (slug: string): Promise<boolean> => stored.includes(slug),
      extraProviders: async (): Promise<ExtraProvider[]> => [],
      validateKey: async (slug: string, key: string): Promise<ValidateResult> => {
        calls.push([slug, key])
        return result
      },
    },
  } satisfies ApiClient
}

/** The key input and Test button of whichever provider form is rendered. */
function keyRow(root: HTMLElement): {
  input: HTMLInputElement
  test: HTMLButtonElement
  status: () => string
} {
  const input = root.querySelector<HTMLInputElement>('.provider-field-group input')
  const group = root.querySelector<HTMLElement>('.provider-field-group')
  const test = [...(group?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (b) => b.textContent === 'Test key',
  )
  const status = group?.querySelector<HTMLElement>('.key-status')
  assert.ok(input && test && status)
  return { input, test, status: () => status.textContent }
}

/** Click and let the handler's async body settle. */
async function click(button: HTMLButtonElement): Promise<void> {
  button.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('custom providers: Test key', () => {
  it('tests the saved key when the field is empty', async () => {
    const calls: [string, string][] = []
    const section = createCustomProvidersSection(stubApi(['openai'], calls))
    await section.refresh()

    const { input, test, status } = keyRow(section.root)
    assert.equal(input.value, '', 'a saved key is never read back into the field')

    await click(test)

    // Empty string is the contract for "the key already in use" — the main
    // process resolves it, so the secret never reaches the renderer.
    assert.deepEqual(calls, [['openai', '']])
    assert.match(status(), /Key looks valid/)
  })

  it('lets the main process distinguish an environment key from no configured key', async () => {
    const calls: [string, string][] = []
    const section = createCustomProvidersSection(
      stubApi([], calls, { ok: false, error: 'No key configured for this provider' }),
    )
    await section.refresh()

    const { test, status } = keyRow(section.root)
    await click(test)

    assert.deepEqual(calls, [['openai', '']])
    assert.match(status(), /No key configured for this provider/)
  })

  it('prefers a typed key over the saved one', async () => {
    const calls: [string, string][] = []
    const section = createCustomProvidersSection(stubApi(['openai'], calls))
    await section.refresh()

    const { input, test } = keyRow(section.root)
    input.value = 'sk-typed'
    input.dispatchEvent(new Event('input'))
    await click(test)

    assert.deepEqual(calls, [['openai', 'sk-typed']])
  })

  it('surfaces the reason a saved key fails', async () => {
    const calls: [string, string][] = []
    const section = createCustomProvidersSection(
      stubApi(['openai'], calls, { ok: false, error: 'Key rejected by OpenAI' }),
    )
    await section.refresh()

    const { test, status } = keyRow(section.root)
    await click(test)

    assert.match(status(), /Key rejected by OpenAI/)
  })
})

describe('custom providers: plaintext storage policy', () => {
  it('keeps a new provider key staged when plaintext storage is disabled', async () => {
    const base = createFakeApi()
    const custom: ExtraProvider = {
      id: 'example',
      label: 'Example',
      baseUrl: 'https://api.example.com/v1',
      keyLabel: 'API key',
      keyPlaceholder: 'API key',
      keyHint: 'Stored locally.',
      prefix: 'example:',
      builtin: false,
      local: false,
      fallbackContextWindow: 128_000,
      models: [],
    }
    let providers: ExtraProvider[] = []
    let keyWrites = 0
    const api: ApiClient = {
      ...base,
      settings: {
        ...base.settings,
        get: async (): Promise<unknown> => null,
        getKey: async (): Promise<boolean> => false,
        extraProviders: async (): Promise<ExtraProvider[]> => providers,
        saveExtraProvider: async (): Promise<ExtraProvider[]> => {
          providers = [custom]
          return providers
        },
        setKey: async () => {
          keyWrites += 1
          return { ok: false, reason: 'plaintext-storage-disabled' }
        },
      },
    }

    const section = createCustomProvidersSection(api, { embedded: true })
    await section.refresh()
    section.select('other')

    const valueFor = (placeholder: string): HTMLInputElement => {
      const input = section.root.querySelector<HTMLInputElement>(
        `input[placeholder="${placeholder}"]`,
      )
      assert.ok(input)
      return input
    }
    valueFor('Display name').value = 'Example'
    valueFor('https://api.example.com/v1').value = custom.baseUrl
    valueFor('slug (auto)').value = custom.id
    valueFor('API key (optional)').value = 'sk-still-pending'
    const add = [...section.root.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Add provider',
    )
    assert.ok(add)

    await click(add)

    const staged = section.root.querySelector<HTMLInputElement>('input[type="password"]')
    assert.equal(staged?.value, 'sk-still-pending')
    assert.match(section.root.textContent, /COPSE_ALLOW_PLAINTEXT_SECRETS=1/)
    assert.equal(keyWrites, 1)
    assert.equal(await section.saveKeys(), false)
    assert.equal(keyWrites, 2)
  })
})
