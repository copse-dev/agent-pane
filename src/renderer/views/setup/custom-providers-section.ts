import type { ApiClient, ExtraProvider, ExtraProviderModel } from '../../../preload/api.d.ts'
import { providerSlugFromBaseUrl } from '@shared/llm/provider-slug.ts'
import { el, clear } from '../../dom/helpers.ts'

// Unified "Providers" panel: a chip row selects one provider and shows its form.
// Fixed cloud providers (OpenAI / Anthropic / OpenRouter) expose just a key
// field; OpenAI-compatible providers (the Mistral/Gemini/DeepSeek presets plus
// user customs) add a base URL, a structured model list, and advanced options.
// "Other" is the add-a-provider form. One slug per provider drives both the
// `model:` prefix and the `apiKey.<slug>` lookup.

export interface ProvidersSection {
  root: HTMLFieldSetElement
  refresh: () => Promise<void>
  /** Persist any keys typed into the per-provider key fields (called on dialog save). */
  saveKeys: () => Promise<void>
}

// Fixed cloud providers with bespoke key validation (not OpenAI-compatible customs).
interface FixedProvider {
  id: string
  label: string
  placeholder: string
  hint: string
}
const FIXED_PROVIDERS: readonly FixedProvider[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    placeholder: 'sk-…',
    hint: 'For GPT-4o / GPT-5 models. Validated via a free models request — no tokens charged.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    placeholder: 'sk-ant-…',
    hint: 'For Claude Sonnet and Opus. Validated via a free models request — no tokens charged.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    placeholder: 'sk-or-…',
    hint: 'Claude, GPT, Gemini, Llama and more via one key. Add a custom model id in the Chat model section.',
  },
]
const FIXED_BY_ID = new Map(FIXED_PROVIDERS.map((p) => [p.id, p]))

// Order of the leading chips, per design. Remaining customs follow, then "Other".
const CHIP_ORDER: readonly string[] = [
  'openai',
  'gemini',
  'mistral',
  'deepseek',
  'anthropic',
  'openrouter',
]

// Well-known OpenAI-compatible cloud endpoints offered as add-form prefills.
const KNOWN_ENDPOINTS: ReadonlyArray<{ label: string; baseUrl: string }> = [
  { label: 'Together AI', baseUrl: 'https://api.together.xyz/v1' },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1' },
  { label: 'Perplexity', baseUrl: 'https://api.perplexity.ai' },
  { label: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1' },
  { label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1' },
]

// A small structured editor for a provider's model shortlist: one row of
// id / context-window / label inputs each, with add and remove controls.
interface ModelsEditor {
  element: HTMLElement
  read: () => ExtraProviderModel[]
  set: (models: readonly ExtraProviderModel[]) => void
}
function createModelsEditor(initial: readonly ExtraProviderModel[]): ModelsEditor {
  const rows = el('div', { class: 'provider-model-rows' })

  const addRow = (model?: ExtraProviderModel): void => {
    const id = el('input', {
      type: 'text',
      placeholder: 'model-id',
      autocomplete: 'off',
    }) as HTMLInputElement
    const ctx = el('input', {
      type: 'number',
      min: '1',
      placeholder: 'context',
    }) as HTMLInputElement
    const label = el('input', {
      type: 'text',
      placeholder: 'label (optional)',
      autocomplete: 'off',
    }) as HTMLInputElement
    if (model) {
      id.value = model.id
      if (model.contextWindow) ctx.value = String(model.contextWindow)
      if (model.label) label.value = model.label
    }
    const remove = el(
      'button',
      { type: 'button', class: 'provider-model-remove', title: 'Remove model' },
      '✕',
    ) as HTMLButtonElement
    const row = el('div', { class: 'provider-model-row' }, id, ctx, label, remove)
    remove.addEventListener('click', () => row.remove())
    rows.append(row)
  }

  for (const model of initial) addRow(model)

  const addBtn = el(
    'button',
    { type: 'button', class: 'provider-add-model' },
    '+ Add model',
  ) as HTMLButtonElement
  addBtn.addEventListener('click', () => addRow())

  const header = el(
    'div',
    { class: 'provider-model-row provider-model-head' },
    el('span', {}, 'Model id'),
    el('span', {}, 'Context'),
    el('span', {}, 'Label'),
    el('span', {}, ''),
  )

  const element = el('div', { class: 'provider-models' }, header, rows, addBtn)

  const read = (): ExtraProviderModel[] => {
    const out: ExtraProviderModel[] = []
    for (const row of rows.querySelectorAll('.provider-model-row')) {
      const [idEl, ctxEl, labelEl] = row.querySelectorAll('input')
      const id = (idEl as HTMLInputElement).value.trim()
      if (!id) continue
      const ctx = Number((ctxEl as HTMLInputElement).value)
      const label = (labelEl as HTMLInputElement).value.trim()
      out.push({
        id,
        ...(label ? { label } : {}),
        ...(Number.isFinite(ctx) && ctx > 0 ? { contextWindow: ctx } : {}),
      })
    }
    return out
  }
  const set = (models: readonly ExtraProviderModel[]): void => {
    clear(rows)
    for (const model of models) addRow(model)
  }
  return { element, read, set }
}

export function createCustomProvidersSection(api: ApiClient): ProvidersSection {
  const chipRow = el('div', { class: 'provider-chips', role: 'tablist' })
  const formHost = el('div', { class: 'provider-form-host' })

  const fieldset = el(
    'fieldset',
    {},
    el('legend', {}, 'Providers'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Pick a provider to add or edit its API key. OpenAI-compatible endpoints (Mistral, Gemini, DeepSeek ship built in) also let you set models and options; choose “Other” to add your own.',
    ),
    chipRow,
    formHost,
  ) as HTMLFieldSetElement

  // Keys typed but not yet saved, kept across chip switches; flushed by saveKeys().
  const pendingKeys = new Map<string, string>()
  // Saved-key status per slug, for the chip indicator dot.
  const configured = new Set<string>()

  let providers: ExtraProvider[] = []
  let selected = 'openai'

  function chipKeys(): string[] {
    const extraById = new Map(providers.map((p) => [p.id, p]))
    const ordered: string[] = []
    for (const id of CHIP_ORDER) {
      if (FIXED_BY_ID.has(id) || extraById.has(id)) ordered.push(id)
    }
    for (const p of providers) if (!ordered.includes(p.id)) ordered.push(p.id)
    ordered.push('other')
    return ordered
  }

  function chipLabel(key: string): string {
    if (key === 'other') return 'Other'
    return FIXED_BY_ID.get(key)?.label ?? providers.find((p) => p.id === key)?.label ?? key
  }

  function renderChips(): void {
    clear(chipRow)
    for (const key of chipKeys()) {
      const chip = el(
        'button',
        {
          type: 'button',
          class: 'provider-chip',
          role: 'tab',
        },
        chipLabel(key),
      ) as HTMLButtonElement
      chip.classList.toggle('active', key === selected)
      if (key !== 'other' && configured.has(key)) {
        chip.append(el('span', { class: 'provider-chip-dot', title: 'Key configured' }))
      }
      chip.addEventListener('click', () => {
        selected = key
        renderChips()
        renderForm()
      })
      chipRow.append(chip)
    }
  }

  // ---- Shared key field ---------------------------------------------------
  function keyField(slug: string, label: string, placeholder: string, hint: string): HTMLElement {
    const input = el('input', {
      type: 'password',
      placeholder,
      autocomplete: 'off',
    }) as HTMLInputElement
    input.value = pendingKeys.get(slug) ?? ''
    const status = el('span', { class: 'key-status' })
    status.textContent = configured.has(slug) ? '● saved' : '○ not set'
    input.addEventListener('input', () => {
      if (input.value.trim()) pendingKeys.set(slug, input.value)
      else pendingKeys.delete(slug)
    })

    const test = el('button', { type: 'button' }, 'Test key') as HTMLButtonElement
    test.addEventListener('click', () => {
      void (async () => {
        const key = input.value.trim()
        if (!key) {
          status.textContent = '✗ Enter a key first'
          status.className = 'key-status err'
          return
        }
        status.textContent = 'Testing…'
        status.className = 'key-status'
        try {
          const res = await api.settings.validateKey(slug, key)
          status.textContent = res.ok ? '✓ Key looks valid' : `✗ ${res.error ?? 'Invalid key'}`
          status.className = `key-status ${res.ok ? 'ok' : 'err'}`
        } catch {
          status.textContent = '✗ Could not validate'
          status.className = 'key-status err'
        }
      })()
    })

    return el(
      'div',
      { class: 'provider-field-group' },
      el('label', {}, label, input),
      el('div', { class: 'provider-actions' }, test, status),
      el('span', { class: 'field-hint' }, hint),
    )
  }

  // ---- Fixed provider form ------------------------------------------------
  function fixedForm(fixed: FixedProvider): HTMLElement {
    return el(
      'div',
      { class: 'provider-form' },
      el('h4', { class: 'provider-form-title' }, fixed.label),
      keyField(fixed.id, `${fixed.label} API key`, fixed.placeholder, fixed.hint),
    )
  }

  // ---- Extra (OpenAI-compatible) provider form ----------------------------
  function extraForm(provider: ExtraProvider): HTMLElement {
    const form = el('div', { class: 'provider-form' })

    const title = el(
      'h4',
      { class: 'provider-form-title' },
      provider.label,
      el('span', { class: 'provider-form-tag' }, provider.builtin ? 'built-in' : 'custom'),
    )
    form.append(title)

    const urlInput = el('input', {
      type: 'url',
      value: provider.baseUrl,
      autocomplete: 'off',
      ...(provider.builtin ? { readonly: true } : {}),
    }) as HTMLInputElement
    form.append(el('label', {}, 'Base URL', urlInput))

    form.append(keyField(provider.id, provider.keyLabel, provider.keyPlaceholder, provider.keyHint))

    const editor = createModelsEditor(provider.models)
    const fetchBtn = el('button', { type: 'button' }, 'Fetch models') as HTMLButtonElement
    const fetchStatus = el('span', { class: 'key-status' })
    fetchBtn.addEventListener('click', () => {
      void (async () => {
        fetchStatus.textContent = 'Fetching…'
        fetchStatus.className = 'key-status'
        const key = (pendingKeys.get(provider.id) ?? '').trim()
        const res = await api.settings.fetchProviderModels(urlInput.value.trim(), key || undefined)
        if (!res.ok) {
          fetchStatus.textContent = `✗ ${res.error ?? 'Could not list models'}`
          fetchStatus.className = 'key-status err'
          return
        }
        editor.set(
          res.models.map((m) => ({
            id: m.id,
            ...(m.contextLength ? { contextWindow: m.contextLength } : {}),
          })),
        )
        fetchStatus.textContent = `✓ ${res.models.length} model(s) — review and Save`
        fetchStatus.className = 'key-status ok'
      })()
    })
    form.append(
      el('label', { class: 'provider-models-label' }, 'Models', editor.element),
      el('div', { class: 'provider-actions' }, fetchBtn, fetchStatus),
    )

    // Advanced options.
    const usageBox = el('input', {
      type: 'checkbox',
      ...((provider.includeUsage ?? true) ? { checked: true } : {}),
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
    const advanced = el(
      'details',
      { class: 'provider-advanced' },
      el('summary', {}, 'Advanced'),
      el(
        'label',
        { class: 'checkbox-label' },
        usageBox,
        ' Report token usage (stream_options.include_usage)',
      ),
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
    form.append(advanced)

    // Save / delete actions.
    const saveBtn = el(
      'button',
      { type: 'button', class: 'provider-save' },
      'Save provider settings',
    ) as HTMLButtonElement
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
            ...(provider.builtin ? {} : { label: provider.label, baseUrl: urlInput.value.trim() }),
            models: editor.read(),
            includeUsage: usageBox.checked,
            ...(Number.isFinite(ctx) && ctx > 0 ? { fallbackContextWindow: ctx } : {}),
            ...(extraBody ? { extraBody } : {}),
          })
          saveStatus.textContent = '✓ Saved'
          saveStatus.className = 'key-status ok'
          await refresh()
        } catch (err) {
          saveStatus.textContent = `✗ ${err instanceof Error ? err.message : 'Could not save'}`
          saveStatus.className = 'key-status err'
        }
      })()
    })
    const actions = el(
      'div',
      { class: 'provider-actions provider-form-footer' },
      saveBtn,
      saveStatus,
    )
    if (!provider.builtin) {
      const del = el(
        'button',
        { type: 'button', class: 'provider-delete' },
        'Delete',
      ) as HTMLButtonElement
      del.addEventListener('click', () => {
        void (async () => {
          await api.settings.deleteExtraProvider(provider.id)
          pendingKeys.delete(provider.id)
          selected = 'openai'
          await refresh()
        })().catch(() => {})
      })
      actions.append(del)
    }
    form.append(actions)
    return form
  }

  // ---- "Other" (add a provider) form --------------------------------------
  function otherForm(): HTMLElement {
    const presetSelect = el('select', {}) as HTMLSelectElement
    presetSelect.append(new Option('Custom (enter URL)', ''))
    for (const ep of KNOWN_ENDPOINTS) presetSelect.append(new Option(ep.label, ep.baseUrl))

    const labelInput = el('input', {
      type: 'text',
      placeholder: 'Display name',
      autocomplete: 'off',
    }) as HTMLInputElement
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
    const addBtn = el(
      'button',
      { type: 'button', class: 'provider-save' },
      'Add provider',
    ) as HTMLButtonElement
    const status = el('span', { class: 'key-status' })

    let slugEdited = false
    slugInput.addEventListener('input', () => {
      slugEdited = true
    })
    const repredict = (): void => {
      if (!slugEdited) slugInput.value = providerSlugFromBaseUrl(urlInput.value)
    }
    urlInput.addEventListener('input', repredict)
    presetSelect.addEventListener('change', () => {
      const ep = KNOWN_ENDPOINTS.find((e) => e.baseUrl === presetSelect.value)
      if (ep) {
        urlInput.value = ep.baseUrl
        if (!labelInput.value.trim()) labelInput.value = ep.label
        repredict()
      }
    })

    addBtn.addEventListener('click', () => {
      void (async () => {
        const baseUrl = urlInput.value.trim()
        if (!baseUrl) {
          status.textContent = '✗ Enter a base URL'
          status.className = 'key-status err'
          return
        }
        const slug = (slugInput.value.trim() || providerSlugFromBaseUrl(baseUrl)).toLowerCase()
        const label = labelInput.value.trim()
        status.textContent = 'Saving…'
        status.className = 'key-status'
        try {
          const before = new Set(providers.map((p) => p.id))
          const next = await api.settings.saveExtraProvider({
            ...(slug ? { slug } : {}),
            ...(label ? { label } : {}),
            baseUrl,
          })
          const created = next.find((p) => !before.has(p.id))
          const key = keyInput.value.trim()
          if (key && created) await api.settings.setKey(created.id, key)
          if (created) selected = created.id
          await refresh()
        } catch (err) {
          status.textContent = `✗ ${err instanceof Error ? err.message : 'Could not add provider'}`
          status.className = 'key-status err'
        }
      })()
    })

    return el(
      'div',
      { class: 'provider-form' },
      el('h4', { class: 'provider-form-title' }, 'Add a provider'),
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
      el('div', { class: 'provider-actions provider-form-footer' }, addBtn, status),
    )
  }

  function renderForm(): void {
    clear(formHost)
    if (selected === 'other') {
      formHost.append(otherForm())
      return
    }
    const fixed = FIXED_BY_ID.get(selected)
    if (fixed) {
      formHost.append(fixedForm(fixed))
      return
    }
    const provider = providers.find((p) => p.id === selected)
    if (provider) formHost.append(extraForm(provider))
  }

  async function refresh(): Promise<void> {
    try {
      providers = await api.settings.extraProviders()
    } catch {
      providers = []
    }
    if (
      selected !== 'other' &&
      !FIXED_BY_ID.has(selected) &&
      !providers.some((p) => p.id === selected)
    ) {
      selected = 'openai'
    }
    // Refresh the configured-key indicators for the chips.
    configured.clear()
    const slugs = [...FIXED_PROVIDERS.map((p) => p.id), ...providers.map((p) => p.id)]
    await Promise.all(
      slugs.map(async (slug) => {
        try {
          if (await api.settings.getKey(slug)) configured.add(slug)
        } catch {
          /* ignore */
        }
      }),
    )
    renderChips()
    renderForm()
  }

  async function saveKeys(): Promise<void> {
    for (const [slug, key] of pendingKeys) {
      const trimmed = key.trim()
      if (trimmed) await api.settings.setKey(slug, trimmed)
    }
    pendingKeys.clear()
  }

  return { root: fieldset, refresh, saveKeys }
}
