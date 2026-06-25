import type { ApiClient, ExtraProvider, ExtraProviderModel } from '../../../preload/api.d.ts'
import { providerSlugFromBaseUrl } from '@shared/llm/provider-slug.ts'
import { el, clear } from '../../dom/helpers.ts'

// Settings UI for OpenAI-compatible providers: the shipped presets
// (Mistral/Gemini/DeepSeek, label/URL locked but key/models/flags editable) plus
// as many user-added custom endpoints as wanted. One slug (predicted from the
// base-URL hostname) drives both the `model:` prefix and the API-key lookup.

export interface CustomProvidersSection {
  root: HTMLFieldSetElement
  refresh: () => Promise<void>
  /** Persist any keys typed into the per-provider key fields (called on dialog save). */
  saveKeys: () => Promise<void>
}

// Well-known OpenAI-compatible cloud endpoints offered as add-form prefills.
const KNOWN_ENDPOINTS: ReadonlyArray<{ label: string; baseUrl: string }> = [
  { label: 'Together AI', baseUrl: 'https://api.together.xyz/v1' },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1' },
  { label: 'Perplexity', baseUrl: 'https://api.perplexity.ai' },
  { label: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1' },
  { label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1' },
]

/** `id [| contextWindow [| label]]` per line → model records (and back). */
function parseModelsText(text: string): ExtraProviderModel[] {
  const out: ExtraProviderModel[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [id, ctx, label] = trimmed.split('|').map((p) => p.trim())
    if (!id) continue
    const contextWindow = ctx ? Number(ctx) : NaN
    out.push({
      id,
      ...(label ? { label } : {}),
      ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    })
  }
  return out
}

function formatModelsText(models: readonly ExtraProviderModel[]): string {
  return models
    .map((m) => [m.id, m.contextWindow ?? '', m.label ?? ''].join(' | ').replace(/(\s\|\s*)+$/, ''))
    .join('\n')
}

export function createCustomProvidersSection(api: ApiClient): CustomProvidersSection {
  const list = el('div', { class: 'custom-providers-list' })
  const addStatus = el('span', { class: 'key-status' })

  // ---- Add-provider form -------------------------------------------------
  const presetSelect = el('select', { name: 'newProviderPreset' }) as HTMLSelectElement
  presetSelect.append(new Option('Custom (enter URL)', ''))
  for (const ep of KNOWN_ENDPOINTS) presetSelect.append(new Option(ep.label, ep.baseUrl))

  const labelInput = el('input', { type: 'text', placeholder: 'Display name' }) as HTMLInputElement
  const urlInput = el('input', {
    type: 'url',
    placeholder: 'https://api.example.com/v1',
    autocomplete: 'off',
  }) as HTMLInputElement
  const slugInput = el('input', {
    type: 'text',
    placeholder: 'slug (auto)',
    autocomplete: 'off',
  }) as HTMLInputElement
  const keyInput = el('input', {
    type: 'password',
    placeholder: 'API key (optional)',
    autocomplete: 'off',
  }) as HTMLInputElement
  const addBtn = el('button', { type: 'button' }, 'Add provider') as HTMLButtonElement

  let slugEdited = false
  slugInput.addEventListener('input', () => {
    slugEdited = true
  })
  const repredictSlug = (): void => {
    if (!slugEdited) slugInput.value = providerSlugFromBaseUrl(urlInput.value)
  }
  urlInput.addEventListener('input', repredictSlug)
  presetSelect.addEventListener('change', () => {
    const ep = KNOWN_ENDPOINTS.find((e) => e.baseUrl === presetSelect.value)
    if (ep) {
      urlInput.value = ep.baseUrl
      if (!labelInput.value.trim()) labelInput.value = ep.label
      repredictSlug()
    }
  })

  addBtn.addEventListener('click', () => {
    void (async () => {
      const baseUrl = urlInput.value.trim()
      if (!baseUrl) {
        addStatus.textContent = '✗ Enter a base URL'
        addStatus.className = 'key-status err'
        return
      }
      const slug = (slugInput.value.trim() || providerSlugFromBaseUrl(baseUrl)).toLowerCase()
      const label = labelInput.value.trim()
      addStatus.textContent = 'Saving…'
      addStatus.className = 'key-status'
      try {
        await api.settings.saveExtraProvider({
          ...(slug ? { slug } : {}),
          ...(label ? { label } : {}),
          baseUrl,
        })
        const key = keyInput.value.trim()
        if (key && slug) await api.settings.setKey(slug, key)
        labelInput.value = ''
        urlInput.value = ''
        slugInput.value = ''
        keyInput.value = ''
        slugEdited = false
        presetSelect.value = ''
        addStatus.textContent = '✓ Added'
        addStatus.className = 'key-status ok'
        await refresh()
      } catch (err) {
        addStatus.textContent = `✗ ${err instanceof Error ? err.message : 'Could not add provider'}`
        addStatus.className = 'key-status err'
      }
    })()
  })

  const addForm = el(
    'details',
    { class: 'custom-provider-add' },
    el('summary', {}, 'Add a provider'),
    el('label', {}, 'Known endpoint', presetSelect),
    el('label', {}, 'Display name', labelInput),
    el('label', {}, 'Base URL', urlInput),
    el(
      'label',
      {},
      'Slug',
      slugInput,
      el(
        'span',
        { class: 'field-hint' },
        'Used for the model id prefix and key storage. Predicted from the URL; edit if needed.',
      ),
    ),
    el('label', {}, 'API key', keyInput),
    el('div', { class: 'lmstudio-test-row' }, addBtn, addStatus),
  )

  const fieldset = el(
    'fieldset',
    {},
    el('legend', {}, 'OpenAI-compatible providers'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Add any OpenAI-compatible endpoint (Mistral, Gemini, DeepSeek ship built in). Models can be fetched from the server; context windows fall back per provider when unknown.',
    ),
    list,
    addForm,
  ) as HTMLFieldSetElement

  // Track the key input per provider slug so saveKeys() can flush them together.
  const keyInputs = new Map<string, HTMLInputElement>()

  function providerRow(provider: ExtraProvider): HTMLElement {
    const row = el('div', { class: 'custom-provider-row' })

    const title = el(
      'div',
      { class: 'custom-provider-title' },
      `${provider.label} (${provider.id})`,
      provider.builtin ? el('span', { class: 'field-hint' }, ' · built-in') : '',
    )
    const header = el('div', { class: 'custom-provider-header' }, title)
    if (!provider.builtin) {
      const del = el('button', { type: 'button' }, 'Delete') as HTMLButtonElement
      del.addEventListener('click', () => {
        void api.settings
          .deleteExtraProvider(provider.id)
          .then(() => refresh())
          .catch(() => {})
      })
      header.append(del)
    }
    row.append(header)

    // Base URL: locked for presets, editable for customs.
    const urlField = el('input', {
      type: 'url',
      value: provider.baseUrl,
      autocomplete: 'off',
      ...(provider.builtin ? { readonly: true } : {}),
    }) as HTMLInputElement
    row.append(el('label', {}, 'Base URL', urlField))

    // API key.
    const key = el('input', {
      type: 'password',
      placeholder: provider.keyPlaceholder,
      autocomplete: 'off',
    }) as HTMLInputElement
    const keyStatus = el('span', { class: 'key-status', 'data-key': provider.id })
    keyInputs.set(provider.id, key)
    row.append(
      el('label', {}, provider.keyLabel, key, keyStatus, el('span', { class: 'field-hint' }, provider.keyHint)),
    )

    // Models (editable lines) + fetch button.
    const modelsArea = el('textarea', {
      rows: '4',
      spellcheck: false,
      placeholder: 'model-id | contextWindow | label (one per line)',
    }) as HTMLTextAreaElement
    modelsArea.value = formatModelsText(provider.models)
    const fetchBtn = el('button', { type: 'button' }, 'Fetch models') as HTMLButtonElement
    const fetchStatus = el('span', { class: 'key-status' })
    fetchBtn.addEventListener('click', () => {
      void (async () => {
        fetchStatus.textContent = 'Fetching…'
        fetchStatus.className = 'key-status'
        const res = await api.settings.fetchProviderModels(urlField.value.trim(), key.value.trim() || undefined)
        if (!res.ok) {
          fetchStatus.textContent = `✗ ${res.error ?? 'Could not list models'}`
          fetchStatus.className = 'key-status err'
          return
        }
        modelsArea.value = formatModelsText(
          res.models.map((m) => ({ id: m.id, ...(m.contextLength ? { contextWindow: m.contextLength } : {}) })),
        )
        fetchStatus.textContent = `✓ ${res.models.length} model(s) — review and Save`
        fetchStatus.className = 'key-status ok'
      })()
    })
    row.append(
      el('label', {}, 'Models', modelsArea),
      el('div', { class: 'lmstudio-test-row' }, fetchBtn, fetchStatus),
    )

    // Advanced: usage reporting, fallback context window, extra request body.
    const usageBox = el('input', {
      type: 'checkbox',
      ...(provider.includeUsage ?? true ? { checked: true } : {}),
    }) as HTMLInputElement
    const ctxInput = el('input', {
      type: 'number',
      min: '1',
      value: String(provider.fallbackContextWindow),
    }) as HTMLInputElement
    const extraBodyArea = el('textarea', {
      rows: '3',
      spellcheck: false,
      placeholder: '{ "provider": { "require_parameters": true } }',
    }) as HTMLTextAreaElement
    extraBodyArea.value = provider.extraBody ? JSON.stringify(provider.extraBody, null, 2) : ''
    const saveBtn = el('button', { type: 'button' }, 'Save provider settings') as HTMLButtonElement
    const saveStatus = el('span', { class: 'key-status' })
    saveBtn.addEventListener('click', () => {
      void (async () => {
        let extraBody: Record<string, unknown> | undefined
        const raw = extraBodyArea.value.trim()
        if (raw) {
          try {
            extraBody = JSON.parse(raw) as Record<string, unknown>
          } catch {
            saveStatus.textContent = '✗ Extra body is not valid JSON'
            saveStatus.className = 'key-status err'
            return
          }
        }
        const ctx = Number(ctxInput.value)
        try {
          await api.settings.saveExtraProvider({
            slug: provider.id,
            // Presets ignore label/baseUrl edits; send them only for customs.
            ...(provider.builtin ? {} : { label: provider.label, baseUrl: urlField.value.trim() }),
            models: parseModelsText(modelsArea.value),
            includeUsage: usageBox.checked,
            ...(Number.isFinite(ctx) && ctx > 0 ? { fallbackContextWindow: ctx } : {}),
            ...(extraBody ? { extraBody } : {}),
          })
          saveStatus.textContent = '✓ Saved'
          saveStatus.className = 'key-status ok'
        } catch (err) {
          saveStatus.textContent = `✗ ${err instanceof Error ? err.message : 'Could not save'}`
          saveStatus.className = 'key-status err'
        }
      })()
    })
    const advanced = el(
      'details',
      { class: 'custom-provider-advanced' },
      el('summary', {}, 'Advanced'),
      el('label', { class: 'checkbox-label' }, usageBox, ' Report token usage (stream_options.include_usage)'),
      el(
        'label',
        {},
        'Fallback context window',
        ctxInput,
        el('span', { class: 'field-hint' }, 'Used for models without a known size.'),
      ),
      el(
        'label',
        {},
        'Extra request body (JSON)',
        extraBodyArea,
        el(
          'span',
          { class: 'field-hint' },
          'Merged into every request — e.g. OpenRouter routing hints. Most providers need none.',
        ),
      ),
    )
    row.append(advanced, el('div', { class: 'lmstudio-test-row' }, saveBtn, saveStatus))
    return row
  }

  async function refresh(): Promise<void> {
    let providers: ExtraProvider[] = []
    try {
      providers = await api.settings.extraProviders()
    } catch {
      /* leave empty */
    }
    keyInputs.clear()
    clear(list)
    for (const provider of providers) list.append(providerRow(provider))
    await refreshKeyStatus()
  }

  async function refreshKeyStatus(): Promise<void> {
    for (const [slug, input] of keyInputs) {
      if (input.value.trim()) continue
      try {
        const saved = await api.settings.getKey(slug)
        const status = list.querySelector<HTMLElement>(`.key-status[data-key="${slug}"]`)
        if (status) {
          status.textContent = saved ? '● saved' : '○ not set'
          status.className = 'key-status'
        }
      } catch {
        /* ignore */
      }
    }
  }

  async function saveKeys(): Promise<void> {
    for (const [slug, input] of keyInputs) {
      const key = input.value.trim()
      if (key) await api.settings.setKey(slug, key)
      input.value = ''
    }
    await refreshKeyStatus()
  }

  return { root: fieldset, refresh, saveKeys }
}
