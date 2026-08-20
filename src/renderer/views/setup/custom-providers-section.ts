import type { ApiClient, ExtraProvider, ExtraProviderModel } from '../../../preload/api.d.ts'
import { providerSlugFromBaseUrl } from '@copse/llm/provider-slug.ts'
import {
  dataPolicyForProvider,
  openRouterDataPolicy,
  privacyBadge,
  type PrivacyBadge,
  type ProviderDataPolicy,
} from '@copse/llm/data-policies.ts'
import { blendedRate } from '@copse/llm/pareto-frontier.ts'
import { el, clear } from '../../dom/helpers.ts'
import { closeIcon, plusIcon } from '../../dom/icons.ts'
import { setInlineStatus } from '../../dom/inline-status.ts'
import { showConfirmDialog } from '../../views/confirm-dialog.ts'
import { expectRecord } from '@shared/unknown-value.ts'

// Unified "Providers" panel: a chip row selects one provider and shows its form.
// Fixed cloud providers (OpenAI / Anthropic / OpenRouter) expose just a key
// field; OpenAI-compatible provider presets and user customs add a base URL, a
// structured model list, and advanced options.
// "Other" is the add-a-provider form. One slug per provider drives both the
// `model:` prefix and the `apiKey.<slug>` lookup.

export interface ProvidersSection {
  root: HTMLElement
  refresh: () => Promise<void>
  /** Persist any keys typed into the per-provider key fields (called on dialog save). */
  saveKeys: () => Promise<void>
  /** Ids this panel can render a form for, excluding the add-a-provider form. */
  providerIds: () => string[]
  /** Display name for an id this panel owns, or null when it owns no such id. */
  labelFor: (id: string) => string | null
  /** Whether the provider has a saved key (or is a user-added entry). */
  isConfigured: (id: string) => boolean
  /**
   * Embedded mode only: show one provider's form (or the add form for `'other'`).
   * An id this panel does not own leaves the panel empty, so a host that stacks
   * several panels can hand the same id to all of them.
   */
  select: (id: string) => void
}

/**
 * A provider with its own bespoke form (not the generic OpenAI-compatible editor),
 * shown as a leading chip in the local panel. LM Studio uses this so its dedicated
 * server-connection + model-download UI lives inside the unified Local providers
 * panel as the first chip, while keeping its separate backend wiring.
 */
export interface NativeProvider {
  id: string
  label: string
  /** Pre-built form element rendered when this chip is selected. */
  element: HTMLElement
  /** Re-run any detection/refresh when the panel refreshes (e.g. dialog open). */
  refresh?: () => void | Promise<void>
}

// Fixed cloud providers with bespoke key validation (not OpenAI-compatible presets).
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
    hint: 'Checked with a free request, so no tokens are charged.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    placeholder: 'sk-ant-…',
    hint: 'Checked with a free request, so no tokens are charged.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    placeholder: 'sk-or-…',
    hint: 'Claude, GPT, Gemini, Llama and more via one key. Add a custom model id below.',
  },
]
// Order of the leading cloud chips, per design. Remaining customs follow, then
// "Other". Local-server presets are ordered separately (LOCAL_CHIP_ORDER).
const CHIP_ORDER: readonly string[] = [
  'openai',
  'perplexity',
  'groq',
  'together',
  'fireworks',
  'gemini',
  'mistral',
  'deepseek',
  'anthropic',
  'openrouter',
  'huggingface',
]

// Built-in local-server preset slugs, in chip order (see BUILTIN_EXTRA_PROVIDERS).
const LOCAL_CHIP_ORDER: readonly string[] = ['ollama', 'llamacpp', 'jan', 'vllm']

interface KnownEndpoint {
  label: string
  baseUrl: string
  /** Explicit slug; loopback hosts all derive "localhost", so locals supply one. */
  slug?: string
}

// Well-known OpenAI-compatible cloud endpoints offered as add-form prefills.
const CLOUD_KNOWN_ENDPOINTS: readonly KnownEndpoint[] = [
  { label: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1' },
]

// Local servers that don't have a built-in preset chip, offered as prefills in
// the local "Other" form. Each carries an explicit slug because every loopback
// host would otherwise collapse to the slug "localhost".
const LOCAL_KNOWN_ENDPOINTS: readonly KnownEndpoint[] = [
  { label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', slug: 'lmstudio-local' },
  { label: 'KoboldCpp', baseUrl: 'http://127.0.0.1:5001/v1', slug: 'koboldcpp' },
  { label: 'text-generation-webui', baseUrl: 'http://127.0.0.1:5000/v1', slug: 'textgen' },
]

// ---- Privacy badge -------------------------------------------------------
// Data-policy badge + hint shown in every provider form so it's visible where
// prompts go by default (see packages/llm/src/data-policies.ts and
// docs/provider-data-policies.md). The badge compresses the policy to one of
// local / zdr / no-training / trains / unknown; the hint carries the detail
// and the primary source.
function privacyBadgeEl(badge: PrivacyBadge): HTMLElement {
  return el('span', { class: `provider-privacy-badge ${badge.kind}` }, badge.label)
}

function policyHintEl(policy: ProviderDataPolicy): HTMLElement {
  return el(
    'span',
    { class: 'field-hint provider-privacy-hint' },
    `${policy.note} Source: `,
    el('code', {}, policy.policyUrl.replace(/^https:\/\//, '')),
  )
}

// A small structured editor for a provider's model shortlist: one row of
// id / context-window / in & out price / label inputs each, with add and remove
// controls. Prices are USD per million tokens; blank means unpriced (no cost
// estimate). For HF these are auto-filled by the fetch and overwritten on the
// next refetch; for custom providers they're the only way to opt into costing.
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
    })
    const ctx = el('input', {
      type: 'number',
      min: '1',
      placeholder: 'context',
    })
    const inPrice = el('input', {
      type: 'number',
      min: '0',
      step: 'any',
      placeholder: 'in $/Mtok',
    })
    const outPrice = el('input', {
      type: 'number',
      min: '0',
      step: 'any',
      placeholder: 'out $/Mtok',
    })
    const blended = el('span', { class: 'provider-model-blended' })
    const updateBlended = (): void => {
      const inStr = inPrice.value.trim()
      const outStr = outPrice.value.trim()
      const inNum = Number(inStr)
      const outNum = Number(outStr)
      if (inStr && outStr && Number.isFinite(inNum) && Number.isFinite(outNum)) {
        blended.textContent = blendedRate(inNum, outNum).toFixed(2)
      } else if (
        typeof model?.inputPricePerMTok === 'number' &&
        typeof model.outputPricePerMTok === 'number'
      ) {
        blended.textContent = String(blendedRate(model.inputPricePerMTok, model.outputPricePerMTok))
      } else if (model?.blendedCostPerMTok != null) {
        blended.textContent = String(model.blendedCostPerMTok)
      } else {
        blended.textContent = ''
      }
    }
    inPrice.addEventListener('input', updateBlended)
    outPrice.addEventListener('input', updateBlended)
    if (model) {
      id.value = model.id
      if (model.contextWindow) ctx.value = String(model.contextWindow)
      if (typeof model.inputPricePerMTok === 'number')
        inPrice.value = String(model.inputPricePerMTok)
      if (typeof model.outputPricePerMTok === 'number')
        outPrice.value = String(model.outputPricePerMTok)
      updateBlended()
    }
    const remove = el(
      'button',
      { type: 'button', class: 'provider-model-remove', title: 'Remove model' },
      closeIcon('ui-icon ui-icon-sm'),
    )
    const row = el(
      'div',
      { class: 'provider-model-row' },
      id,
      ctx,
      inPrice,
      outPrice,
      blended,
      remove,
    )
    remove.addEventListener('click', () => {
      row.remove()
    })
    rows.append(row)
  }

  for (const model of initial) addRow(model)

  const addBtn = el(
    'button',
    { type: 'button', class: 'provider-add-model' },
    plusIcon('ui-icon ui-icon-sm'),
    'Add model',
  )
  addBtn.addEventListener('click', () => {
    addRow()
  })

  const header = el(
    'div',
    { class: 'provider-model-row provider-model-head' },
    el('span', {}, 'Model id'),
    el('span', {}, 'Context'),
    el('span', {}, 'In $/Mtok'),
    el('span', {}, 'Out $/Mtok'),
    el('span', {}, 'Blended $/MTok'),
    el('span', {}, ''),
  )

  const element = el('div', { class: 'provider-models' }, header, rows, addBtn)

  const read = (): ExtraProviderModel[] => {
    const out: ExtraProviderModel[] = []
    for (const row of rows.querySelectorAll('.provider-model-row')) {
      const inputs = row.querySelectorAll<HTMLInputElement>('input')
      const idEl = inputs[0]
      const ctxEl = inputs[1]
      const inEl = inputs[2]
      const outEl = inputs[3]
      if (!idEl || !ctxEl || !inEl || !outEl) continue
      const id = idEl.value.trim()
      if (!id) continue
      const ctx = Number(ctxEl.value)
      const inPrice = inEl.value.trim()
      const outPrice = outEl.value.trim()
      const inNum = Number(inPrice)
      const outNum = Number(outPrice)
      const entry: ExtraProviderModel = {
        id,
        ...(Number.isFinite(ctx) && ctx > 0 ? { contextWindow: ctx } : {}),
        ...(inPrice && Number.isFinite(inNum) && inNum >= 0 ? { inputPricePerMTok: inNum } : {}),
        ...(outPrice && Number.isFinite(outNum) && outNum >= 0
          ? { outputPricePerMTok: outNum }
          : {}),
      }
      if (
        typeof entry.inputPricePerMTok === 'number' &&
        typeof entry.outputPricePerMTok === 'number'
      ) {
        entry.blendedCostPerMTok = blendedRate(entry.inputPricePerMTok, entry.outputPricePerMTok)
      }
      out.push(entry)
    }
    return out
  }
  const set = (models: readonly ExtraProviderModel[]): void => {
    clear(rows)
    for (const model of models) addRow(model)
  }
  return { element, read, set }
}

export function createCustomProvidersSection(
  api: ApiClient,
  opts: {
    variant?: 'cloud' | 'local'
    nativeProviders?: readonly NativeProvider[]
    /**
     * Render only the form for the currently selected provider, with no legend,
     * description, or chip row of its own. The host (providers-section.ts) owns
     * one chip row across every provider panel and drives this one via `select`.
     */
    embedded?: boolean
    /** Fired after a refresh so an embedded host can rebuild its chip row. */
    onChanged?: () => void
  } = {},
): ProvidersSection {
  // The same panel renders two ways: the cloud variant (General settings) shows
  // hosted providers; the local variant shows loopback
  // OpenAI-compatible servers. Providers are partitioned by their `local` flag so
  // a given provider appears in exactly one panel.
  const isLocal = opts.variant === 'local'
  const embedded = opts.embedded ?? false
  // Native providers (e.g. LM Studio) lead the local chip row with their own form.
  const nativeProviders = isLocal ? (opts.nativeProviders ?? []) : []
  const nativeById = new Map(nativeProviders.map((p) => [p.id, p]))
  const fixedProviders: readonly FixedProvider[] = isLocal ? [] : FIXED_PROVIDERS
  const fixedById = new Map(fixedProviders.map((p) => [p.id, p]))
  const chipOrder = isLocal
    ? [...nativeProviders.map((p) => p.id), ...LOCAL_CHIP_ORDER]
    : CHIP_ORDER
  const knownEndpoints = isLocal ? LOCAL_KNOWN_ENDPOINTS : CLOUD_KNOWN_ENDPOINTS
  const defaultSelected = isLocal
    ? (nativeProviders[0]?.id ?? LOCAL_CHIP_ORDER[0] ?? 'other')
    : 'openai'

  const chipRow = el('div', { class: 'provider-chips', role: 'tablist' })
  const formHost = el('div', { class: 'provider-form-host' })

  const root: HTMLElement = embedded
    ? el('div', { class: 'provider-panel-embedded' }, formHost)
    : el(
        'fieldset',
        {},
        el('legend', {}, isLocal ? 'Local providers' : 'Providers'),
        el(
          'p',
          { class: 'settings-fieldset-desc' },
          isLocal
            ? 'Connect OpenAI-compatible servers running on your own machine. LM Studio, Ollama, llama.cpp, Jan, and vLLM are built in and need no API key: pick one, set its URL or fetch its models, then Save. Choose “Other” to add a different local endpoint.'
            : 'Pick a provider to add or edit its API key. Groq, Together AI, and Fireworks AI are built in alongside Mistral, Gemini, and DeepSeek. OpenAI-compatible providers also let you set models and options; choose “Other” to add your own.',
        ),
        chipRow,
        formHost,
      )

  // Keys typed but not yet saved, kept across chip switches; flushed by saveKeys().
  const pendingKeys = new Map<string, string>()
  // Saved-key status per slug, for the chip indicator dot.
  const configured = new Set<string>()

  let providers: ExtraProvider[] = []
  let selected = embedded ? '' : defaultSelected
  // OpenRouter-only custom model id (cloud panel). Loaded on refresh, edited in
  // the OpenRouter form, flushed by saveKeys — mirrors the pendingKeys pattern
  // so an unsaved edit survives chip switches and only persists on dialog Save.
  let openRouterModelValue = ''
  let pendingOpenRouterModel: string | null = null
  // OpenRouter privacy-routing toggles. Same pending pattern: the checkboxes
  // edit the `pending*` values, flushed to the settings on Save. ZDR-only
  // defaults ON; allow-training defaults OFF — they are independent axes
  // (retention vs training) in OpenRouter's routing policy.
  let openRouterZdrValue = true
  let pendingOpenRouterZdr: boolean | null = null
  let openRouterAllowTrainingValue = false
  let pendingOpenRouterAllowTraining: boolean | null = null
  let openRouterFreeModeValue = false
  let pendingOpenRouterFreeMode: boolean | null = null

  function chipKeys(): string[] {
    const extraById = new Map(providers.map((p) => [p.id, p]))
    const ordered: string[] = []
    for (const id of chipOrder) {
      if (nativeById.has(id) || fixedById.has(id) || extraById.has(id)) ordered.push(id)
    }
    for (const p of providers) if (!ordered.includes(p.id)) ordered.push(p.id)
    ordered.push('other')
    return ordered
  }

  function chipLabel(key: string): string {
    if (key === 'other') return 'Other'
    return (
      nativeById.get(key)?.label ??
      fixedById.get(key)?.label ??
      providers.find((p) => p.id === key)?.label ??
      key
    )
  }

  function renderChips(): void {
    if (embedded) return
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
      )
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
    })
    input.value = pendingKeys.get(slug) ?? ''
    const status = el('span', { class: 'key-status' })
    setInlineStatus(
      status,
      configured.has(slug) ? 'filled' : 'idle',
      configured.has(slug) ? 'saved' : 'not set',
    )
    input.addEventListener('input', () => {
      if (input.value.trim()) pendingKeys.set(slug, input.value)
      else pendingKeys.delete(slug)
    })

    const test = el('button', { type: 'button', class: 'ui-btn ui-btn-secondary' }, 'Test key')
    test.addEventListener('click', () => {
      void (async (): Promise<void> => {
        const key = input.value.trim()
        if (!key) {
          setInlineStatus(status, 'error', 'Enter a key first')
          status.className = 'key-status err'
          return
        }
        setInlineStatus(status, 'pending', 'Testing…')
        status.className = 'key-status'
        try {
          const res = await api.settings.validateKey(slug, key)
          setInlineStatus(
            status,
            res.ok ? 'ok' : 'error',
            res.ok ? 'Key looks valid' : (res.error ?? 'Invalid key'),
          )
          status.className = `key-status ${res.ok ? 'ok' : 'err'}`
        } catch {
          setInlineStatus(status, 'error', 'Could not validate')
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

  // ---- OpenRouter custom model field --------------------------------------
  // A free-text model id that augments the built-in OpenRouter shortlist in the
  // model picker. Lives inside the OpenRouter provider form (next to its key)
  // rather than the generic Chat model section so every OpenRouter control sits
  // together.
  function openRouterModelField(): HTMLElement {
    const input = el('input', {
      type: 'text',
      name: 'openRouterModel',
      placeholder: 'vendor/model (e.g. anthropic/claude-3.7-sonnet)',
      autocomplete: 'off',
    })
    input.value = pendingOpenRouterModel ?? openRouterModelValue
    input.addEventListener('input', () => {
      pendingOpenRouterModel = input.value
    })

    const freeModeBox = el('input', {
      type: 'checkbox',
      name: 'openRouterFreeMode',
    })
    if (pendingOpenRouterFreeMode ?? openRouterFreeModeValue) freeModeBox.checked = true
    freeModeBox.addEventListener('change', () => {
      pendingOpenRouterFreeMode = freeModeBox.checked
    })

    return el(
      'div',
      { class: 'provider-field-group' },
      el('label', {}, 'Custom model', input),
      el(
        'span',
        { class: 'field-hint' },
        'Adds a model to the picker beyond the built-in OpenRouter shortlist. Needs the key above. Browse the full list at ',
        el('code', {}, 'openrouter.ai/models'),
        '.',
      ),
      el('label', { class: 'checkbox-label' }, freeModeBox, ' Show only free models'),
      el(
        'span',
        { class: 'field-hint' },
        'When unchecked, the model picker lists every tool-capable OpenRouter model, not just :free tiers.',
      ),
    )
  }

  // ---- OpenRouter privacy-routing toggles ----------------------------------
  // Two independent axes (see @copse/llm/data-policies.ts):
  // - ZDR-only (default ON): provider.zdr=true routes only to zero-retention
  //   endpoints. Models without one — most ":free" variants — fail routing.
  // - Allow may-train providers (default OFF): drops data_collection:"deny".
  //   Kept separate so relaxing ZDR never silently re-admits trainers.
  function openRouterPrivacyFields(): HTMLElement {
    const zdrBox = el('input', { type: 'checkbox' })
    zdrBox.checked = pendingOpenRouterZdr ?? openRouterZdrValue
    zdrBox.addEventListener('change', () => {
      pendingOpenRouterZdr = zdrBox.checked
      // Re-render so the privacy badge in the form title tracks the choice.
      renderForm()
    })
    const trainBox = el('input', { type: 'checkbox' })
    trainBox.checked = pendingOpenRouterAllowTraining ?? openRouterAllowTrainingValue
    trainBox.addEventListener('change', () => {
      pendingOpenRouterAllowTraining = trainBox.checked
      renderForm()
    })
    return el(
      'div',
      { class: 'provider-field-group' },
      el(
        'label',
        { class: 'checkbox-label' },
        zdrBox,
        ' Only route to zero-data-retention providers (ZDR)',
      ),
      el(
        'span',
        { class: 'field-hint' },
        'Restricts routing to providers that never store your prompts. While this is on, the model picker only lists models that can be served that way, and anything else fails to route.',
      ),
      el(
        'label',
        { class: 'checkbox-label' },
        trainBox,
        ' Allow providers that may train on prompts',
      ),
      el(
        'span',
        { class: 'field-hint' },
        'Off by default, which rules out anyone who stores or trains on your prompts, even when the option above is off. Turn this on only if you need a model that is served exclusively by providers who may train on it, which is common for free models.',
      ),
    )
  }

  // ---- Fixed provider form ------------------------------------------------
  function fixedForm(fixed: FixedProvider): HTMLElement {
    const policy =
      fixed.id === 'openrouter'
        ? openRouterDataPolicy(
            pendingOpenRouterZdr ?? openRouterZdrValue,
            pendingOpenRouterAllowTraining ?? openRouterAllowTrainingValue,
          )
        : dataPolicyForProvider({ id: fixed.id })
    const form = el(
      'div',
      { class: 'provider-form' },
      el('h4', { class: 'provider-form-title' }, fixed.label, privacyBadgeEl(privacyBadge(policy))),
      keyField(fixed.id, `${fixed.label} API key`, fixed.placeholder, fixed.hint),
    )
    if (fixed.id === 'openrouter') form.append(openRouterPrivacyFields(), openRouterModelField())
    if (policy) form.append(policyHintEl(policy))
    return form
  }

  // ---- Extra (OpenAI-compatible) provider form ----------------------------
  function extraForm(provider: ExtraProvider): HTMLElement {
    const form = el('div', { class: 'provider-form' })

    const policy = provider.local ? null : dataPolicyForProvider(provider)
    const title = el(
      'h4',
      { class: 'provider-form-title' },
      provider.label,
      el('span', { class: 'provider-form-tag' }, provider.builtin ? 'built-in' : 'custom'),
      privacyBadgeEl(privacyBadge(policy, { local: provider.local })),
    )
    form.append(title)
    if (policy) form.append(policyHintEl(policy))

    const urlInput = el('input', {
      type: 'url',
      value: provider.baseUrl,
      autocomplete: 'off',
      ...(provider.builtin ? { readonly: true } : {}),
    })
    form.append(el('label', {}, 'Base URL', urlInput))

    form.append(keyField(provider.id, provider.keyLabel, provider.keyPlaceholder, provider.keyHint))

    const editor = createModelsEditor(provider.models)
    const isHuggingFace = provider.id === 'huggingface'
    const fetchBtn = el(
      'button',
      { type: 'button', class: 'ui-btn ui-btn-secondary' },
      'Fetch models',
    )
    const fetchStatus = el('span', { class: 'key-status' })
    fetchBtn.addEventListener('click', () => {
      void (async (): Promise<void> => {
        setInlineStatus(fetchStatus, 'pending', 'Fetching…')
        fetchStatus.className = 'key-status'
        const key = (pendingKeys.get(provider.id) ?? '').trim()
        // HF's router exposes per-provider pricing/context the generic /models
        // endpoint lacks, so it has a dedicated fetch that resolves the cheapest
        // live provider, pins it, and persists prices — then we reload the form.
        if (isHuggingFace) {
          const res = await api.settings.refreshHuggingFaceModels(key || undefined)
          if (!res.ok) {
            const hint = !key ? '. Enter your Hugging Face token and try again.' : ''
            setInlineStatus(fetchStatus, 'error', `${res.error ?? 'Could not list models'}${hint}`)
            fetchStatus.className = 'key-status err'
            return
          }
          setInlineStatus(fetchStatus, 'ok', `${String(res.count)} model(s) imported with pricing`)
          fetchStatus.className = 'key-status ok'
          await refresh()
          return
        }
        const res = await api.settings.fetchProviderModels(urlInput.value.trim(), key || undefined)
        if (!res.ok) {
          // Most cloud providers reject an unauthenticated /models request (Google
          // even 404s it), so nudge toward entering a key before blaming the URL.
          const hint = !key ? '. Enter an API key and try again.' : ''
          setInlineStatus(fetchStatus, 'error', `${res.error ?? 'Could not list models'}${hint}`)
          fetchStatus.className = 'key-status err'
          return
        }
        editor.set(
          res.models.map((m) => ({
            id: m.id,
            ...(m.contextLength ? { contextWindow: m.contextLength } : {}),
          })),
        )
        setInlineStatus(
          fetchStatus,
          'ok',
          `${String(res.models.length)} model(s). Review them, then Save.`,
        )
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
    })
    const ctxInput = el('input', {
      type: 'number',
      min: '1',
      value: String(provider.fallbackContextWindow),
    })
    const extraBodyArea = el('textarea', {
      rows: '3',
      spellcheck: false,
      placeholder: '{ "provider": { "require_parameters": true } }',
    })
    extraBodyArea.value = provider.extraBody ? JSON.stringify(provider.extraBody, null, 2) : ''
    const advanced = el(
      'details',
      { class: 'provider-advanced' },
      el('summary', {}, 'Advanced'),
      el(
        'label',
        { class: 'checkbox-label' },
        usageBox,
        provider.apiStyle === 'responses'
          ? ' Report token usage from the completed response'
          : ' Report token usage (stream_options.include_usage)',
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
          'Added to every request, for example routing hints. Most providers need none.',
        ),
      ),
    )
    form.append(advanced)

    // Save / delete actions.
    const saveBtn = el(
      'button',
      { type: 'button', class: 'provider-save' },
      'Save provider settings',
    )
    const saveStatus = el('span', { class: 'key-status' })
    saveBtn.addEventListener('click', () => {
      void (async (): Promise<void> => {
        let extraBody: Record<string, unknown> | undefined
        const raw = extraBodyArea.value.trim()
        if (raw) {
          try {
            extraBody = expectRecord(JSON.parse(raw) as unknown)
          } catch {
            setInlineStatus(saveStatus, 'error', 'Extra body is not valid JSON')
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
          setInlineStatus(saveStatus, 'ok', 'Saved')
          saveStatus.className = 'key-status ok'
          await refresh()
        } catch (err) {
          setInlineStatus(
            saveStatus,
            'error',
            err instanceof Error ? err.message : 'Could not save',
          )
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
      const del = el('button', { type: 'button', class: 'provider-delete' }, 'Delete')
      del.addEventListener('click', () => {
        void (async (): Promise<void> => {
          await api.settings.deleteExtraProvider(provider.id)
          pendingKeys.delete(provider.id)
          selected = embedded ? '' : defaultSelected
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
    const presetSelect = el('select', {})
    presetSelect.append(el('option', { value: '' }, 'Custom (enter URL)'))
    for (const ep of knownEndpoints) {
      presetSelect.append(el('option', { value: ep.baseUrl }, ep.label))
    }

    const labelInput = el('input', {
      type: 'text',
      placeholder: 'Display name',
      autocomplete: 'off',
    })
    const urlInput = el('input', {
      type: 'url',
      placeholder: isLocal ? 'http://127.0.0.1:11434/v1' : 'https://api.example.com/v1',
      autocomplete: 'off',
    })
    const slugInput = el('input', {
      type: 'text',
      placeholder: 'slug (auto)',
      autocomplete: 'off',
    })
    const keyInput = el('input', {
      type: 'password',
      placeholder: 'API key (optional)',
      autocomplete: 'off',
    })
    const addBtn = el('button', { type: 'button', class: 'provider-save' }, 'Add provider')
    const status = el('span', { class: 'key-status' })

    // Track manual edits so a preset switch overwrites auto-filled values but
    // never clobbers something the user typed themselves.
    let slugEdited = false
    let labelEdited = false
    slugInput.addEventListener('input', () => {
      slugEdited = true
    })
    labelInput.addEventListener('input', () => {
      labelEdited = true
    })
    const repredict = (): void => {
      if (!slugEdited) slugInput.value = providerSlugFromBaseUrl(urlInput.value)
    }
    urlInput.addEventListener('input', repredict)
    presetSelect.addEventListener('change', () => {
      const ep = knownEndpoints.find((e) => e.baseUrl === presetSelect.value)
      if (ep) {
        urlInput.value = ep.baseUrl
        if (!labelEdited) labelInput.value = ep.label
        // Loopback hosts all derive the slug "localhost", so prefer the preset's
        // explicit slug when it supplies one; otherwise fall back to prediction.
        if (!slugEdited && ep.slug) slugInput.value = ep.slug
        else repredict()
      }
    })

    addBtn.addEventListener('click', () => {
      void (async (): Promise<void> => {
        const baseUrl = urlInput.value.trim()
        if (!baseUrl) {
          setInlineStatus(status, 'error', 'Enter a base URL')
          status.className = 'key-status err'
          return
        }
        const key = keyInput.value.trim()
        const slug = (slugInput.value.trim() || providerSlugFromBaseUrl(baseUrl)).toLowerCase()
        const label = labelInput.value.trim()
        setInlineStatus(status, 'pending', 'Saving…')
        status.className = 'key-status'
        try {
          const next = await api.settings.saveExtraProvider({
            ...(slug ? { slug } : {}),
            ...(label ? { label } : {}),
            baseUrl,
          })
          const savedRecord = next.find((p) => p.id === slug)
          // The resolved slug is the provider we just created (or re-saved), so
          // persist any entered key against it right here on "Add" — not gated
          // on the `created` diff, which is only the brand-new entry and is
          // empty on a re-add. Without this the key does not survive a restart
          // because the dialog-level save flushes only `pendingKeys`, and a
          // fresh add never put the value there.
          if (key) {
            const saved = await persistProviderKey(slug, key, label || (savedRecord?.label ?? slug))
            if (!saved) {
              setInlineStatus(status, 'error', 'Provider saved, but the key was not stored')
              status.className = 'key-status err'
            }
          } else {
            // No key typed: still stage a future value under the resolved slug
            // so a later Save with a key has a stable target.
            pendingKeys.set(slug, '')
          }
          if (savedRecord) selected = savedRecord.id
          await refresh()
        } catch (err) {
          setInlineStatus(
            status,
            'error',
            err instanceof Error ? err.message : 'Could not add provider',
          )
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
    const native = nativeById.get(selected)
    if (native) {
      formHost.append(native.element)
      return
    }
    const fixed = fixedById.get(selected)
    if (fixed) {
      formHost.append(fixedForm(fixed))
      return
    }
    const provider = providers.find((p) => p.id === selected)
    if (provider) formHost.append(extraForm(provider))
  }

  async function refresh(): Promise<void> {
    try {
      const all = await api.settings.extraProviders()
      // Each provider belongs to exactly one panel: local servers here, hosted
      // providers in the cloud panel.
      providers = all.filter((p) => (isLocal ? p.local : !p.local))
    } catch {
      providers = []
    }
    // Embedded panels take their selection from the host, which may name a
    // provider another panel owns; leave it unset rather than snapping back to
    // this panel's default (that would render a form the host didn't ask for).
    if (
      !embedded &&
      selected !== 'other' &&
      !nativeById.has(selected) &&
      !fixedById.has(selected) &&
      !providers.some((p) => p.id === selected)
    ) {
      selected = defaultSelected
    }
    // Load the OpenRouter custom model id (cloud panel only) so its form field
    // reflects the stored value; unsaved edits (pending) still take precedence.
    if (!isLocal) {
      try {
        const saved = await api.settings.get('openRouterModel')
        openRouterModelValue = typeof saved === 'string' ? saved : ''
      } catch {
        openRouterModelValue = ''
      }
      try {
        const zdr = await api.settings.get('openRouterZdrOnly')
        // Default ON: only an explicit stored `false` turns ZDR-only routing off.
        openRouterZdrValue = zdr !== false
      } catch {
        openRouterZdrValue = true
      }
      try {
        // Default OFF: only an explicit stored `true` admits may-train providers.
        openRouterAllowTrainingValue = (await api.settings.get('openRouterAllowTraining')) === true
      } catch {
        openRouterAllowTrainingValue = false
      }
      try {
        openRouterFreeModeValue = (await api.settings.get('openRouterFreeMode')) === true
      } catch {
        openRouterFreeModeValue = false
      }
    }
    // Let native providers (LM Studio) re-run their own detection.
    await Promise.all(nativeProviders.map(async (p) => p.refresh?.()))
    // Refresh the configured-key indicators for the chips.
    configured.clear()
    const slugs = [...fixedProviders.map((p) => p.id), ...providers.map((p) => p.id)]
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
    opts.onChanged?.()
  }

  // Per-key plaintext storage consent, matching the fixed cloud-provider flow
  // (api-keys-section.ts). Shown only when OS secure storage is unavailable
  // and the user has not yet approved storing this key unencrypted.
  async function confirmPlaintextStorage(label: string): Promise<boolean> {
    return showConfirmDialog({
      message: `No OS keyring is available to encrypt your ${label} key at rest. Install and unlock a system keyring to store it encrypted.`,
      detail: 'Store it unencrypted on this machine anyway?',
      confirmLabel: 'Store anyway',
    })
  }

  // Display label for a provider slug, used in the plaintext-consent prompt.
  function providerLabelFor(slug: string): string {
    return (
      providers.find((p) => p.id === slug)?.label ??
      nativeById.get(slug)?.label ??
      fixedById.get(slug)?.label ??
      slug
    )
  }

  // Persist one key, honouring the plaintext gate the same way the fixed
  // cloud-provider section does (api-keys-section.ts): an OS-secure-storage
  // refusal returns `plaintext-consent-required`, so prompt for explicit
  // consent and retry with `allowPlaintext` before giving up. Without this the
  // key would be dropped silently and "forgotten" next launch.
  async function persistProviderKey(slug: string, key: string, label: string): Promise<boolean> {
    const trimmed = key.trim()
    if (!trimmed) return true
    let result = await api.settings.setKey(slug, trimmed)
    if (!result.ok && (await confirmPlaintextStorage(label))) {
      result = await api.settings.setKey(slug, trimmed, { allowPlaintext: true })
    }
    return result.ok
  }

  async function saveKeys(): Promise<void> {
    for (const [slug, key] of pendingKeys) {
      await persistProviderKey(slug, key, providerLabelFor(slug))
    }
    pendingKeys.clear()
    // Persist the OpenRouter custom model id only if it was touched, so leaving
    // the field alone never clobbers a previously saved value.
    if (pendingOpenRouterModel !== null) {
      const trimmed = pendingOpenRouterModel.trim()
      await api.settings.set('openRouterModel', trimmed)
      openRouterModelValue = trimmed
      pendingOpenRouterModel = null
    }
    // Persist the privacy-routing toggles only when they were touched.
    if (pendingOpenRouterZdr !== null) {
      await api.settings.set('openRouterZdrOnly', pendingOpenRouterZdr)
      openRouterZdrValue = pendingOpenRouterZdr
      pendingOpenRouterZdr = null
    }
    if (pendingOpenRouterAllowTraining !== null) {
      await api.settings.set('openRouterAllowTraining', pendingOpenRouterAllowTraining)
      openRouterAllowTrainingValue = pendingOpenRouterAllowTraining
      pendingOpenRouterAllowTraining = null
    }
    if (pendingOpenRouterFreeMode !== null) {
      await api.settings.set('openRouterFreeMode', pendingOpenRouterFreeMode)
      openRouterFreeModeValue = pendingOpenRouterFreeMode
      pendingOpenRouterFreeMode = null
    }
  }

  function providerIds(): string[] {
    return chipKeys().filter((key) => key !== 'other')
  }

  function labelFor(id: string): string | null {
    return providerIds().includes(id) ? chipLabel(id) : null
  }

  function isConfigured(id: string): boolean {
    if (configured.has(id)) return true
    // A user-added provider counts as set up even without a key: local servers
    // (and some gateways) accept unauthenticated requests.
    const provider = providers.find((p) => p.id === id)
    return provider ? !provider.builtin : false
  }

  function select(id: string): void {
    selected = id
    renderForm()
  }

  return { root, refresh, saveKeys, providerIds, labelFor, isConfigured, select }
}
